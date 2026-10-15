# Prompts

User prompts, verbatim, in order.

## 2026-10-15 (time not recorded)

i am building "DataCobbler", a chat agent on cloudflare (agents sdk, AiChatAgent, workers AI) that cleans uploaded CSVs. Requirements: LLM, a multi step workflow, chat UI, persistent memory. Propose an architecture: components, data flow, what lives in durable object state vs a workflow. Point out risks. No code yet

## 2026-10-15 19:10 IST

- maximum CSV size could be 5mbs initially
- yes one agent per user
- safe operations can automatically
- yes CSV is the only output format. I will come to this in a bit

and yes you should always record my prompt as instructed include the first one. Before recording the decision/progress, i want to clarify few things:

- i want to save the recipe of steps applied to the csv data. This would be saved per chat. Right? This means if user ends the chat, the recipe is gone? Where will the recipe go? and if user wants to apply the recipe to a different csv, then we need a way to let user download the recipe
- i dont have a good term for the "recipe" - may be we call it transformation or a pipeline? pipeline is a series of transformations or steps applied to the data.
- user should be able to modify a step, reorder the pipeline steps, get a preview of steps and finally run a pipeline
- also share the most common and useful transformations we gonna support for our app

## 2026-10-15 19:26 IST

these are good enough. I would also want to add math and window functions - summarize this as you did for other transformations types.

one thing before you start: how many llm tools would there be total? do we call each transformation type a tool or everything bundled into into one tool?

## 2026-10-15 19:44 IST

looks good enough. lets record this. before i set a goal, lets fix one issue in this starter template project. I tried to use model "llama-3.3-70b-instruct-fp8-fast" in place of the given model "moonshotai/kimi-k2.7-code" in the code, there is some issue that prevents llm to respond to my queries regarding weather. Can you check what is it. Is this model specific or something else? I could not test against the default model given in the code because that needs me to upgrade to paid plan

## 2026-10-15 19:53 IST

lets do this: "Wrap the AI binding to strip the duplicate field from each chunk". We will use this workaround until cloudflare fixes the provider. Can you also make sure that replace llama with any other model doesnt break the llm call. In other words, our workaround should fix the llama issue but also allow swapping the llama with any other model. Once done, i will test it once before moving to the actual goal

## 2026-10-15 20:03 IST

it works. ready for the goal?

## 2026-10-15 20:07 IST

/goal lets start goal 1. This will be a very small goal:

- turn the starter into DataCobbler: rename the ChatAgent class, project name(if not already done)
- remove the demo tools
- write a DataCobbler system prompt
- update the README - it should now reflect DataCobbler not the cloudflare starter template

## 2026-10-15 20:15 IST

/goal lets move to next goal:

Upload and profile implementations. Upload a CSV of up to 5 MB to R2, parse it, and show a profile with columns, types, and detected issues. This needs a CSV parser and tests.
