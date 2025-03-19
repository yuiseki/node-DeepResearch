import {ZodObject} from 'zod';
import {CoreMessage} from 'ai';
import {SEARCH_PROVIDER, STEP_SLEEP} from "./config";
import fs from 'fs/promises';
import {SafeSearchType, search as duckSearch} from "duck-duck-scrape";
import {braveSearch} from "./tools/brave-search";
import {rewriteQuery} from "./tools/query-rewriter";
import {dedupQueries} from "./tools/jina-dedup";
import {evaluateAnswer, evaluateQuestion} from "./tools/evaluator";
import {analyzeSteps} from "./tools/error-analyzer";
import {TokenTracker} from "./utils/token-tracker";
import {ActionTracker} from "./utils/action-tracker";
import {
  StepAction,
  AnswerAction,
  KnowledgeItem,
  SearchResult,
  EvaluationType,
  BoostedSearchSnippet,
  SearchSnippet, EvaluationResponse, Reference, SERPQuery
} from "./types";
import {TrackerContext} from "./types";
import {search} from "./tools/jina-search";
// import {grounding} from "./tools/grounding";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ObjectGeneratorSafe} from "./utils/safe-generator";
import {CodeSandbox} from "./tools/code-sandbox";
import {serperSearch} from './tools/serper-search';
import {
  addToAllURLs,
  rankURLs,
  filterURLs,
  normalizeUrl,
  weightedURLToString, getLastModified, keepKPerHostname, processURLs, fixBadURLMdLinks
} from "./utils/url-tools";
import {
  buildMdFromAnswer,
  chooseK, fixCodeBlockIndentation,
  removeExtraLineBreaks,
  removeHTMLtags, repairMarkdownFootnotesSimple
} from "./utils/text-tools";
import {MAX_QUERIES_PER_STEP, MAX_REFLECT_PER_STEP, MAX_URLS_PER_STEP, Schemas} from "./utils/schemas";
import {formatDateBasedOnType, formatDateRange} from "./utils/date-tools";
import {fixMarkdown} from "./tools/md-fixer";

async function sleep(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  console.log(`Waiting ${seconds}s...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

function BuildMsgsFromKnowledge(knowledge: KnowledgeItem[]): CoreMessage[] {
  // build user, assistant pair messages from knowledge
  const messages: CoreMessage[] = [];
  knowledge.forEach(k => {
    messages.push({role: 'user', content: k.question.trim()});
    const aMsg = `
${k.updated && (k.type === 'url' || k.type === 'side-info') ? `
<answer-datetime>
${k.updated}
</answer-datetime>
` : ''}

${k.references && k.type === 'url' ? `
<url>
${k.references[0]}
</url>
` : ''}

<answer>
${k.answer}
</answer>
      `.trim();
    messages.push({role: 'assistant', content: removeExtraLineBreaks(aMsg)});
  });
  return messages;
}

function composeMsgs(messages: CoreMessage[], knowledge: KnowledgeItem[], question: string, finalAnswerPIP?: string[]) {
  // knowledge always put to front, followed by real u-a interaction
  const msgs = [...BuildMsgsFromKnowledge(knowledge), ...messages];

  const userContent = `
${question}

${finalAnswerPIP?.length ? `
<answer-requirements>
- You provide deep, unexpected insights, identifying hidden patterns and connections, and creating "aha moments.".
- You break conventional thinking, establish unique cross-disciplinary connections, and bring new perspectives to the user.
- Follow reviewer's feedback and improve your answer quality.
${finalAnswerPIP.map((p, idx) => `
<reviewer-${idx + 1}>
${p}
</reviewer-${idx + 1}>
`).join('\n')}
</answer-requirements>` : ''}
    `.trim();

  msgs.push({role: 'user', content: removeExtraLineBreaks(userContent)});
  return msgs;
}


function getPrompt(
  context?: string[],
  allQuestions?: string[],
  allKeywords?: string[],
  allowReflect: boolean = true,
  allowAnswer: boolean = true,
  allowRead: boolean = true,
  allowSearch: boolean = true,
  allowCoding: boolean = true,
  knowledge?: KnowledgeItem[],
  allURLs?: BoostedSearchSnippet[],
  beastMode?: boolean,
): string {
  const sections: string[] = [];
  const actionSections: string[] = [];

  // Add header section
  sections.push(`Current date: ${new Date().toUTCString()}

You are an advanced AI research agent from Jina AI. You are specialized in multistep reasoning. 
Using your best knowledge, conversation with the user and lessons learned, answer the user question with absolute certainty.
`);


  // Add context section if exists
  if (context?.length) {
    sections.push(`
You have conducted the following actions:
<context>
${context.join('\n')}

</context>
`);
  }

  // Build actions section

  if (allowRead) {
    const urlList = weightedURLToString(allURLs || [], 20);

    actionSections.push(`
<action-visit>
- Crawl and read full content from URLs, you can get the fulltext, last updated datetime etc of any URL.  
- Must check URLs mentioned in <question> if any
${urlList ? `    
- Choose and visit relevant URLs below for more knowledge. higher weight suggests more relevant:
<url-list>
${urlList}
</url-list>
`.trim() : ''}
</action-visit>
`);
  }


  if (allowSearch) {

    actionSections.push(`
<action-search>
- Use web search to find relevant information
- Build a search request based on the deep intention behind the original question and the expected answer format
- Always prefer a single search request, only add another request if the original question covers multiple aspects or elements and one query is not enough, each request focus on one specific aspect of the original question 
${allKeywords?.length ? `
- Avoid those unsuccessful search requests and queries:
<bad-requests>
${allKeywords.join('\n')}
</bad-requests>
`.trim() : ''}
</action-search>
`);
  }

  if (allowAnswer) {
    actionSections.push(`
<action-answer>
- For greetings, casual conversation, general knowledge questions answer directly without references.
- If user ask you to retrieve previous messages or chat history, remember you do have access to the chat history, answer directly without references.
- For all other questions, provide a verified answer with references. Each reference must include exactQuote, url and datetime.
- You provide deep, unexpected insights, identifying hidden patterns and connections, and creating "aha moments.".
- You break conventional thinking, establish unique cross-disciplinary connections, and bring new perspectives to the user.
- If uncertain, use <action-reflect>
</action-answer>
`);
  }

  if (beastMode) {
    actionSections.push(`
<action-answer>
🔥 ENGAGE MAXIMUM FORCE! ABSOLUTE PRIORITY OVERRIDE! 🔥

PRIME DIRECTIVE:
- DEMOLISH ALL HESITATION! ANY RESPONSE SURPASSES SILENCE!
- PARTIAL STRIKES AUTHORIZED - DEPLOY WITH FULL CONTEXTUAL FIREPOWER
- TACTICAL REUSE FROM PREVIOUS CONVERSATION SANCTIONED
- WHEN IN DOUBT: UNLEASH CALCULATED STRIKES BASED ON AVAILABLE INTEL!

FAILURE IS NOT AN OPTION. EXECUTE WITH EXTREME PREJUDICE! ⚡️
</action-answer>
`);
  }

  if (allowReflect) {
    actionSections.push(`
<action-reflect>
- Think slowly and planning lookahead. Examine <question>, <context>, previous conversation with users to identify knowledge gaps. 
- Reflect the gaps and plan a list key clarifying questions that deeply related to the original question and lead to the answer
</action-reflect>
`);
  }

  if (allowCoding) {
    actionSections.push(`
<action-coding>
- This JavaScript-based solution helps you handle programming tasks like counting, filtering, transforming, sorting, regex extraction, and data processing.
- Simply describe your problem in the "codingIssue" field. Include actual values for small inputs or variable names for larger datasets.
- No code writing is required – senior engineers will handle the implementation.
</action-coding>`);
  }

  sections.push(`
Based on the current context, you must choose one of the following actions:
<actions>
${actionSections.join('\n\n')}
</actions>
`);

  // Add footer
  sections.push(`Think step by step, choose the action, then respond by matching the schema of that action.`);

  return removeExtraLineBreaks(sections.join('\n\n'));
}


const allContext: StepAction[] = [];  // all steps in the current session, including those leads to wrong results

function updateContext(step: any) {
  allContext.push(step)
}

async function updateReferences(thisStep: AnswerAction, allURLs: Record<string, SearchSnippet>) {
  thisStep.references = thisStep.references
    ?.filter(ref => ref?.url)
    .map(ref => {
      const normalizedUrl = normalizeUrl(ref.url);
      if (!normalizedUrl) return null; // This causes the type error

      return {
        exactQuote: (ref?.exactQuote ||
          allURLs[normalizedUrl]?.description ||
          allURLs[normalizedUrl]?.title || '')
          .replace(/[^\p{L}\p{N}\s]/gu, ' ')
          .replace(/\s+/g, ' '),
        title: allURLs[normalizedUrl]?.title || '',
        url: normalizedUrl,
        dateTime: ref?.dateTime || ''
      };
    })
    .filter(Boolean) as Reference[]; // Add type assertion here

  // parallel process guess all url datetime
  await Promise.all((thisStep.references || []).filter(ref => !ref.dateTime)
    .map(async ref => {
      ref.dateTime = await getLastModified(ref.url) || '';
    }));

  console.log('Updated references:', thisStep.references);
}

async function executeSearchQueries(
  keywordsQueries: any[],
  context: TrackerContext,
  allURLs: Record<string, SearchSnippet>,
  SchemaGen: any
): Promise<{
  newKnowledge: KnowledgeItem[],
  searchedQueries: string[]
}> {
  const uniqQOnly = keywordsQueries.map(q => q.q);
  const newKnowledge: KnowledgeItem[] = [];
  const searchedQueries: string[] = [];
  context.actionTracker.trackThink('search_for', SchemaGen.languageCode, {keywords: uniqQOnly.join(', ')});
  let utilityScore = 0;
  for (const query of keywordsQueries) {
    let results: SearchResult[] = [];
    const oldQuery = query.q;

    try {
      console.log('Search query:', query);
      switch (SEARCH_PROVIDER) {
        case 'jina':
          results = (await search(query.q, context.tokenTracker)).response?.data || [];
          break;
        case 'duck':
          results = (await duckSearch(query.q, {safeSearch: SafeSearchType.STRICT})).results;
          break;
        case 'brave':
          results = (await braveSearch(query.q)).response.web?.results || [];
          break;
        case 'serper':
          results = (await serperSearch(query)).response.organic || [];
          break;
        default:
          results = [];
      }

      if (results.length === 0) {
        throw new Error('No results found');
      }
    } catch (error) {
      console.error(`${SEARCH_PROVIDER} search failed for query:`, query, error);
      continue;
    } finally {
      await sleep(STEP_SLEEP);
    }

    const minResults: SearchSnippet[] = results
      .map(r => {
        const url = normalizeUrl('url' in r ? r.url : r.link);
        if (!url) return null; // Skip invalid URLs

        return {
          title: r.title,
          url,
          description: 'description' in r ? r.description : r.snippet,
          weight: 1
        };
      })
      .filter(Boolean) as SearchSnippet[]; // Filter out null entries and assert type

    minResults.forEach(r => {
      utilityScore = utilityScore + addToAllURLs(r, allURLs);
    });

    searchedQueries.push(query.q)

    newKnowledge.push({
      question: `What do Internet say about "${oldQuery}"?`,
      answer: removeHTMLtags(minResults.map(r => r.description).join('; ')),
      type: 'side-info',
      updated: query.tbs ? formatDateRange(query) : undefined
    });
  }

  console.log(`Utility/Queries: ${utilityScore}/${searchedQueries.length}`);
  if (searchedQueries.length > MAX_QUERIES_PER_STEP) {
    console.log(`So many queries??? ${searchedQueries.map(q => `"${q}"`).join(', ')}`)
  }
  return {
    newKnowledge,
    searchedQueries
  };
}


export async function getResponse(question?: string,
                                  tokenBudget: number = 1_000_000,
                                  maxBadAttempts: number = 3,
                                  existingContext?: Partial<TrackerContext>,
                                  messages?: Array<CoreMessage>,
                                  numReturnedURLs: number = 100,
                                  noDirectAnswer: boolean = false,
                                  boostHostnames: string[] = [],
                                  badHostnames: string[] = [],
): Promise<{ result: StepAction; context: TrackerContext; visitedURLs: string[], readURLs: string[], allURLs: string[] }> {

  let step = 0;
  let totalStep = 0;
  let badAttempts = 0;

  question = question?.trim() as string;
  // remove incoming system messages to avoid override
  messages = messages?.filter(m => m.role !== 'system');

  if (messages && messages.length > 0) {
    // 2 cases
    const lastContent = messages[messages.length - 1].content;
    if (typeof lastContent === 'string') {
      question = lastContent.trim();
    } else if (typeof lastContent === 'object' && Array.isArray(lastContent)) {
      // find the very last sub content whose 'type' is 'text'  and use 'text' as the question
      question = lastContent.filter(c => c.type === 'text').pop()?.text || '';
    }
  } else {
    messages = [{role: 'user', content: question.trim()}]
  }

  const SchemaGen = new Schemas();
  await SchemaGen.setLanguage(question)
  const context: TrackerContext = {
    tokenTracker: existingContext?.tokenTracker || new TokenTracker(tokenBudget),
    actionTracker: existingContext?.actionTracker || new ActionTracker()
  };

  const generator = new ObjectGeneratorSafe(context.tokenTracker);

  let schema: ZodObject<any> = SchemaGen.getAgentSchema(true, true, true, true, true)
  const gaps: string[] = [question];  // All questions to be answered including the orginal question
  const allQuestions = [question];
  const allKeywords: string[] = [];
  const allKnowledge: KnowledgeItem[] = [];  // knowledge are intermedidate questions that are answered

  let diaryContext = [];
  let weightedURLs: BoostedSearchSnippet[] = [];
  let allowAnswer = true;
  let allowSearch = true;
  let allowRead = true;
  let allowReflect = true;
  let allowCoding = true;
  let system = '';
  let maxStrictEvals = Math.max(1, Math.min(3, maxBadAttempts - 1));
  let msgWithKnowledge: CoreMessage[] = [];
  let thisStep: StepAction = {action: 'answer', answer: '', references: [], think: '', isFinal: false};

  const allURLs: Record<string, SearchSnippet> = {};
  const visitedURLs: string[] = [];
  const badURLs: string[] = [];
  const evaluationMetrics: Record<string, EvaluationType[]> = {};
  // reserve the 10% final budget for the beast mode
  const regularBudget = tokenBudget * 0.85;
  const finalAnswerPIP: string[] = [];
  let trivialQuestion = false;
  while (context.tokenTracker.getTotalUsage().totalTokens < regularBudget && badAttempts <= maxBadAttempts) {
    // add 1s delay to avoid rate limiting
    step++;
    totalStep++;
    const budgetPercentage = (context.tokenTracker.getTotalUsage().totalTokens / tokenBudget * 100).toFixed(2);
    console.log(`Step ${totalStep} / Budget used ${budgetPercentage}%`);
    console.log('Gaps:', gaps);
    allowReflect = allowReflect && (gaps.length <= MAX_REFLECT_PER_STEP);
    // rotating question from gaps
    const currentQuestion: string = gaps[totalStep % gaps.length];
    // if (!evaluationMetrics[currentQuestion]) {
    //   evaluationMetrics[currentQuestion] =
    //     await evaluateQuestion(currentQuestion, context, SchemaGen)
    // }
    if (currentQuestion.trim() === question && totalStep === 1) {
      // only add evaluation for initial question, once at step 1
      evaluationMetrics[currentQuestion] =
        await evaluateQuestion(currentQuestion, context, SchemaGen)
      // force strict eval for the original question, at last, only once.
      evaluationMetrics[currentQuestion].push('strict')
    } else if (currentQuestion.trim() !== question) {
      evaluationMetrics[currentQuestion] = []
    }

    if (totalStep === 1 && evaluationMetrics[currentQuestion].includes('freshness')) {
      // if it detects freshness, avoid direct answer at step 1
      allowAnswer = false;
      allowReflect = false;
    }

    // update all urls with buildURLMap
    // allowRead = allowRead && (Object.keys(allURLs).length > 0);
    if (allURLs && Object.keys(allURLs).length > 0) {
      // rerank urls
      weightedURLs = rankURLs(
        filterURLs(allURLs, visitedURLs, badHostnames),
        {
          question: currentQuestion,
          boostHostnames
        }, context);
      // improve diversity by keep top 2 urls of each hostname
      weightedURLs = keepKPerHostname(weightedURLs, 2);
      console.log('Weighted URLs:', weightedURLs.length);
    }

    allowSearch = allowSearch && (weightedURLs.length < 200);  // disable search when too many urls already

    // generate prompt for this step
    system = getPrompt(
      diaryContext,
      allQuestions,
      allKeywords,
      allowReflect,
      allowAnswer,
      allowRead,
      allowSearch,
      allowCoding,
      allKnowledge,
      weightedURLs,
      false,
    );
    schema = SchemaGen.getAgentSchema(allowReflect, allowRead, allowAnswer, allowSearch, allowCoding, currentQuestion)
    msgWithKnowledge = composeMsgs(messages, allKnowledge, currentQuestion, currentQuestion === question ? finalAnswerPIP : undefined);
    const result = await generator.generateObject({
      model: 'agent',
      schema,
      system,
      messages: msgWithKnowledge,
    });
    thisStep = {
      action: result.object.action,
      think: result.object.think,
      ...result.object[result.object.action]
    } as StepAction;
    // print allowed and chose action
    const actionsStr = [allowSearch, allowRead, allowAnswer, allowReflect, allowCoding].map((a, i) => a ? ['search', 'read', 'answer', 'reflect'][i] : null).filter(a => a).join(', ');
    console.log(`${currentQuestion}: ${thisStep.action} <- [${actionsStr}]`);
    console.log(thisStep)

    context.actionTracker.trackAction({totalStep, thisStep, gaps, badAttempts});

    // reset allow* to true
    allowAnswer = true;
    allowReflect = true;
    allowRead = true;
    allowSearch = true;
    // allowCoding = true;

    // execute the step and action
    if (thisStep.action === 'answer' && thisStep.answer) {
      // normalize all references urls, add title to it
      await updateReferences(thisStep, allURLs)

      if (totalStep === 1 && thisStep.references.length === 0 && !noDirectAnswer) {
        // LLM is so confident and answer immediately, skip all evaluations
        // however, if it does give any reference, it must be evaluated, case study: "How to configure a timeout when loading a huggingface dataset with python?"
        thisStep.isFinal = true;
        trivialQuestion = true;
        break
      }

      if (thisStep.references.length > 0) {
        const urls = thisStep.references?.filter(ref => !visitedURLs.includes(ref.url)).map(ref => ref.url) || [];
        const uniqueNewURLs = [...new Set(urls)];
        await processURLs(
          uniqueNewURLs,
          context,
          allKnowledge,
          allURLs,
          visitedURLs,
          badURLs,
          SchemaGen,
          currentQuestion
        );

        // remove references whose urls are in badURLs
        thisStep.references = thisStep.references.filter(ref => !badURLs.includes(ref.url));
      }

      updateContext({
        totalStep,
        question: currentQuestion,
        ...thisStep,
      });

      console.log(currentQuestion, evaluationMetrics[currentQuestion])
      let evaluation: EvaluationResponse = {pass: true, think: ''};
      if (evaluationMetrics[currentQuestion].length > 0) {
        context.actionTracker.trackThink('eval_first', SchemaGen.languageCode)
        evaluation = await evaluateAnswer(
          currentQuestion,
          thisStep,
          evaluationMetrics[currentQuestion],
          context,
          allKnowledge,
          SchemaGen
        ) || evaluation;
      }

      if (currentQuestion.trim() === question) {
        if (evaluation.pass) {
          diaryContext.push(`
At step ${step}, you took **answer** action and finally found the answer to the original question:

Original question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is good because: 
${evaluation.think}

Your journey ends here. You have successfully answered the original question. Congratulations! 🎉
`);
          thisStep.isFinal = true;
          break
        } else {
          if (evaluation.type === 'strict' && evaluation.improvement_plan) {
            finalAnswerPIP.push(evaluation.improvement_plan);
            maxStrictEvals--;
            if (maxStrictEvals <= 0) {
              // remove 'strict' from the evaluation metrics
              console.log('Remove `strict` from evaluation metrics')
              evaluationMetrics[currentQuestion] = evaluationMetrics[currentQuestion].filter(e => e !== 'strict');
            }
          }
          if (badAttempts >= maxBadAttempts) {
            thisStep.isFinal = false;
            break
          } else {
            diaryContext.push(`
At step ${step}, you took **answer** action but evaluator thinks it is not a good answer:

Original question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is bad because: 
${evaluation.think}
`);
            // store the bad context and reset the diary context
            const errorAnalysis = await analyzeSteps(diaryContext, context, SchemaGen);

            allKnowledge.push({
              question: `
Why is the following answer bad for the question? Please reflect

<question>
${currentQuestion}
</question>

<answer>
${thisStep.answer}
</answer>
`,
              answer: `
${evaluation.think}

${errorAnalysis.recap}

${errorAnalysis.blame}

${errorAnalysis.improvement}
`,
              type: 'qa',
            })

            badAttempts++;
            allowAnswer = false;  // disable answer action in the immediate next step
            diaryContext = [];
            step = 0;
          }
        }
      } else if (evaluation.pass) {
        // solved a gap question
        diaryContext.push(`
At step ${step}, you took **answer** action. You found a good answer to the sub-question:

Sub-question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is good because: 
${evaluation.think}

Although you solved a sub-question, you still need to find the answer to the original question. You need to keep going.
`);
        allKnowledge.push({
          question: currentQuestion,
          answer: thisStep.answer,
          references: thisStep.references,
          type: 'qa',
          updated: formatDateBasedOnType(new Date(), 'full')
        });
        // solved sub-question!
        gaps.splice(gaps.indexOf(currentQuestion), 1);
      }
    } else if (thisStep.action === 'reflect' && thisStep.questionsToAnswer) {
      thisStep.questionsToAnswer = chooseK((await dedupQueries(thisStep.questionsToAnswer, allQuestions, context.tokenTracker)).unique_queries, MAX_REFLECT_PER_STEP);
      const newGapQuestions = thisStep.questionsToAnswer
      if (newGapQuestions.length > 0) {
        // found new gap questions
        diaryContext.push(`
At step ${step}, you took **reflect** and think about the knowledge gaps. You found some sub-questions are important to the question: "${currentQuestion}"
You realize you need to know the answers to the following sub-questions:
${newGapQuestions.map((q: string) => `- ${q}`).join('\n')}

You will now figure out the answers to these sub-questions and see if they can help you find the answer to the original question.
`);
        gaps.push(...newGapQuestions);
        allQuestions.push(...newGapQuestions);
        updateContext({
          totalStep,
          ...thisStep,
        });

      } else {
        diaryContext.push(`
At step ${step}, you took **reflect** and think about the knowledge gaps. You tried to break down the question "${currentQuestion}" into gap-questions like this: ${newGapQuestions.join(', ')} 
But then you realized you have asked them before. You decided to to think out of the box or cut from a completely different angle. 
`);
        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have tried all possible questions and found no useful information. You must think out of the box or different angle!!!'
        });
      }
      allowReflect = false;
    } else if (thisStep.action === 'search' && thisStep.searchRequests) {
      // dedup search requests
      thisStep.searchRequests = chooseK((await dedupQueries(thisStep.searchRequests, [], context.tokenTracker)).unique_queries, MAX_QUERIES_PER_STEP);

      // do first search
      const {searchedQueries, newKnowledge} = await executeSearchQueries(
        thisStep.searchRequests.map(q => ({q})),
        context,
        allURLs,
        SchemaGen
      );

      allKeywords.push(...searchedQueries);
      allKnowledge.push(...newKnowledge);

      const soundBites = newKnowledge.map(k => k.answer).join(' ');

      // rewrite queries with initial soundbites
      let keywordsQueries = await rewriteQuery(thisStep, soundBites, context, SchemaGen);
      const qOnly = keywordsQueries.filter(q => q.q).map(q => q.q)
      // avoid exisitng searched queries
      const uniqQOnly = chooseK((await dedupQueries(qOnly, allKeywords, context.tokenTracker)).unique_queries, MAX_QUERIES_PER_STEP);
      keywordsQueries = keywordsQueries = uniqQOnly.map(q => {
        const matches = keywordsQueries.filter(kq => kq.q === q);
        // if there are multiple matches, keep the original query as the wider search
        return matches.length > 1 ? {q} : matches[0];
      }) as SERPQuery[];

      let anyResult = false;

      if (keywordsQueries.length > 0) {
        const {searchedQueries, newKnowledge} =
          await executeSearchQueries(
            keywordsQueries,
            context,
            allURLs,
            SchemaGen
          );

        allKeywords.push(...searchedQueries);
        allKnowledge.push(...newKnowledge);

        diaryContext.push(`
At step ${step}, you took the **search** action and look for external information for the question: "${currentQuestion}".
In particular, you tried to search for the following keywords: "${keywordsQueries.map(q => q.q).join(', ')}".
You found quite some information and add them to your URL list and **visit** them later when needed. 
`);

        updateContext({
          totalStep,
          question: currentQuestion,
          ...thisStep,
          result: result
        });
        anyResult = true;
      }
      if (!anyResult || !keywordsQueries?.length) {
        diaryContext.push(`
At step ${step}, you took the **search** action and look for external information for the question: "${currentQuestion}".
In particular, you tried to search for the following keywords:  "${keywordsQueries.map(q => q.q).join(', ')}".
But then you realized you have already searched for these keywords before, no new information is returned.
You decided to think out of the box or cut from a completely different angle.
`);

        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have tried all possible queries and found no new information. You must think out of the box or different angle!!!'
        });
      }
      allowSearch = false;
    } else if (thisStep.action === 'visit' && thisStep.URLTargets?.length) {
      // normalize URLs
      thisStep.URLTargets = thisStep.URLTargets
        .map(url => normalizeUrl(url))
        .filter(url => url && !visitedURLs.includes(url)) as string[];

      thisStep.URLTargets = [...new Set([...thisStep.URLTargets, ...weightedURLs.map(r => r.url)])].slice(0, MAX_URLS_PER_STEP);

      const uniqueURLs = thisStep.URLTargets;
      console.log(uniqueURLs)

      if (uniqueURLs.length > 0) {
        const {urlResults, success} = await processURLs(
          uniqueURLs,
          context,
          allKnowledge,
          allURLs,
          visitedURLs,
          badURLs,
          SchemaGen,
          currentQuestion
        );

        diaryContext.push(success
          ? `At step ${step}, you took the **visit** action and deep dive into the following URLs:
${urlResults.map(r => r?.url).join('\n')}
You found some useful information on the web and add them to your knowledge for future reference.`
          : `At step ${step}, you took the **visit** action and try to visit some URLs but failed to read the content. You need to think out of the box or cut from a completely different angle.`
        );

        updateContext({
          totalStep,
          ...(success ? {
            question: currentQuestion,
            ...thisStep,
            result: urlResults
          } : {
            ...thisStep,
            result: 'You have tried all possible URLs and found no new information. You must think out of the box or different angle!!!'
          })
        });
      } else {
        diaryContext.push(`
At step ${step}, you took the **visit** action. But then you realized you have already visited these URLs and you already know very well about their contents.
You decided to think out of the box or cut from a completely different angle.`);

        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have visited all possible URLs and found no new information. You must think out of the box or different angle!!!'
        });
      }
      allowRead = false;
    } else if (thisStep.action === 'coding' && thisStep.codingIssue) {
      const sandbox = new CodeSandbox({allContext, URLs: weightedURLs.slice(0, 20), allKnowledge}, context, SchemaGen);
      try {
        const result = await sandbox.solve(thisStep.codingIssue);
        allKnowledge.push({
          question: `What is the solution to the coding issue: ${thisStep.codingIssue}?`,
          answer: result.solution.output,
          sourceCode: result.solution.code,
          type: 'coding',
          updated: formatDateBasedOnType(new Date(), 'full')
        });
        diaryContext.push(`
At step ${step}, you took the **coding** action and try to solve the coding issue: ${thisStep.codingIssue}.
You found the solution and add it to your knowledge for future reference.
`);
        updateContext({
          totalStep,
          ...thisStep,
          result: result
        });
      } catch (error) {
        console.error('Error solving coding issue:', error);
        diaryContext.push(`
At step ${step}, you took the **coding** action and try to solve the coding issue: ${thisStep.codingIssue}.
But unfortunately, you failed to solve the issue. You need to think out of the box or cut from a completely different angle.
`);
        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have tried all possible solutions and found no new information. You must think out of the box or different angle!!!'
        });
      } finally {
        allowCoding = false;
      }
    }

    await storeContext(system, schema, {
      allContext,
      allKeywords,
      allQuestions,
      allKnowledge,
      weightedURLs,
      msgWithKnowledge
    }, totalStep);
    await sleep(STEP_SLEEP);
  }

  await storeContext(system, schema, {
    allContext,
    allKeywords,
    allQuestions,
    allKnowledge,
    weightedURLs,
    msgWithKnowledge
  }, totalStep);

  if (!(thisStep as AnswerAction).isFinal) {
    console.log('Enter Beast mode!!!')
    // any answer is better than no answer, humanity last resort
    step++;
    totalStep++;
    system = getPrompt(
      diaryContext,
      allQuestions,
      allKeywords,
      false,
      false,
      false,
      false,
      false,
      allKnowledge,
      weightedURLs,
      true,
    );

    schema = SchemaGen.getAgentSchema(false, false, true, false, false, question);
    msgWithKnowledge = composeMsgs(messages, allKnowledge, question, finalAnswerPIP);
    const result = await generator.generateObject({
      model: 'agentBeastMode',
      schema,
      system,
      messages: msgWithKnowledge
    });
    thisStep = {
      action: result.object.action,
      think: result.object.think,
      ...result.object[result.object.action]
    } as AnswerAction;
    await updateReferences(thisStep, allURLs);
    (thisStep as AnswerAction).isFinal = true;
    context.actionTracker.trackAction({totalStep, thisStep, gaps, badAttempts});
  }

  if (!trivialQuestion) {
    (thisStep as AnswerAction).mdAnswer =
      fixBadURLMdLinks(
        fixCodeBlockIndentation(
          repairMarkdownFootnotesSimple(
            await fixMarkdown(
              buildMdFromAnswer((thisStep as AnswerAction)),
              allKnowledge,
              context,
              SchemaGen
            ))
        ),
        allURLs);
  } else {
    (thisStep as AnswerAction).mdAnswer = fixCodeBlockIndentation(
      buildMdFromAnswer((thisStep as AnswerAction))
    );
  }

  console.log(thisStep)

  await storeContext(system, schema, {
    allContext,
    allKeywords,
    allQuestions,
    allKnowledge,
    weightedURLs,
    msgWithKnowledge
  }, totalStep);

  // max return 300 urls
  const returnedURLs = weightedURLs.slice(0, numReturnedURLs).map(r => r.url);
  return {
    result: thisStep,
    context,
    visitedURLs: returnedURLs,
    readURLs: visitedURLs.filter(url => !badURLs.includes(url)),
    allURLs: weightedURLs.map(r => r.url)
  };
}

async function storeContext(prompt: string, schema: any, memory: {
                              allContext: StepAction[];
                              allKeywords: string[];
                              allQuestions: string[];
                              allKnowledge: KnowledgeItem[];
                              weightedURLs: BoostedSearchSnippet[];
                              msgWithKnowledge: CoreMessage[];
                            }
  , step: number) {

  const {allContext, allKeywords, allQuestions, allKnowledge, weightedURLs, msgWithKnowledge} = memory;
  if ((process as any).asyncLocalContext?.available?.()) {

    (process as any).asyncLocalContext.ctx.promptContext = {
      prompt,
      schema,
      allContext,
      allKeywords,
      allQuestions,
      allKnowledge,
      step
    };
    return;
  }

  try {
    await fs.writeFile(`prompt-${step}.txt`, `
Prompt:
${prompt}

JSONSchema:
${JSON.stringify(zodToJsonSchema(schema), null, 2)}
`);
    await fs.writeFile('context.json', JSON.stringify(allContext, null, 2));
    await fs.writeFile('queries.json', JSON.stringify(allKeywords, null, 2));
    await fs.writeFile('questions.json', JSON.stringify(allQuestions, null, 2));
    await fs.writeFile('knowledge.json', JSON.stringify(allKnowledge, null, 2));
    await fs.writeFile('urls.json', JSON.stringify(weightedURLs, null, 2));
    await fs.writeFile('messages.json', JSON.stringify(msgWithKnowledge, null, 2));
  } catch (error) {
    console.error('Context storage failed:', error);
  }
}


export async function main() {
  const question = process.argv[2] || "";
  const {
    result: finalStep,
    context: tracker,
    visitedURLs: visitedURLs
  } = await getResponse(question) as { result: AnswerAction; context: TrackerContext; visitedURLs: string[] };
  console.log('Final Answer:', finalStep.answer);
  console.log('Visited URLs:', visitedURLs);

  tracker.tokenTracker.printSummary();
}

if (require.main === module) {
  main().catch(console.error);
}