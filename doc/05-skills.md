# Skills Guide

Skills are reusable capabilities with encapsulated logic and internal agents.

## What is a Skill?

A **Skill** block packages related functionality:
- Internal agents
- Internal teams
- Shared state
- Export function

## Creating a Skill

```koi
Skill SentimentAnalysis {
  affordance """
  Analyzes text sentiment and returns positive/neutral/negative.
  """

  Agent Analyst : Worker {
    llm default = { provider: "openai", model: "gpt-4o-mini" }

    on analyze(args: Json) {
      playbook """
      Analyze sentiment of: {{args.text}}
      Return JSON: { sentiment, score, rationale }
      """
    }
  }

  Team Internal {
    analyst = Analyst
  }

  export async function run(input: any): Promise<any> {
    const result = await send Internal.event("analyze").role(Worker).any()(input)
    return result
  }
}
```

## Using Skills

```koi
Agent ReviewAgent : Worker {
  uses Skill SentimentAnalysis

  on analyzeReview(args: Json) {
    const sentiment = await this.callSkill('SentimentAnalysis', { text: args.review })

    if (sentiment.sentiment == "negative") {
      return { action: "flag_for_review", sentiment: sentiment }
    }

    return { action: "approve", sentiment: sentiment }
  }
}
```

## Skill Structure

- **affordance**: Description of what the skill does
- **Internal agents**: Agents used only within the skill
- **Internal teams**: Team composition for agents
- **export function**: Entry point for using the skill

## Benefits

1. **Reusability**: Use the same skill across multiple agents
2. **Encapsulation**: Internal complexity hidden from users
3. **Composability**: Skills can use other skills
4. **Testing**: Skills can be tested independently

## Multiple Skills

```koi
Agent ContentProcessor : Worker {
  uses Skill SentimentAnalysis
  uses Skill LanguageDetection
  uses Skill TopicExtraction

  on process(args: Json) {
    const lang = await this.callSkill('LanguageDetection', { text: args.text })
    const sentiment = await this.callSkill('SentimentAnalysis', { text: args.text })
    const topics = await this.callSkill('TopicExtraction', { text: args.text })

    return { lang, sentiment, topics }
  }
}
```

## See Also

- **[Core Concepts](01-core-concepts.md)** - Understanding skills philosophy
- **[Agents Guide](03-agents.md)** - Creating agents for skills
- **[Examples](14-examples.md)** - sentiment.koi example

---

**Next**: [LLM Integration](06-llm-integration.md) →
