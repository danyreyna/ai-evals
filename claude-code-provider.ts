import type {
  ApiProvider,
  CallApiContextParams,
  ProviderOptions,
  ProviderResponse,
} from "promptfoo";
import promptfoo from "promptfoo";

// TODO: this wrapper is not needed https://www.promptfoo.dev/docs/providers/claude-agent-sdk/
type Config = Record<string, string | number>;
export default class CustomApiProvider implements ApiProvider {
  protected providerId: string;
  public config: Config;

  constructor(options: ProviderOptions) {
    this.providerId = options.id || "claude-code-provider";

    /*
     * `options.config` contains any custom options passed to the provider
     * e.g., `temperature`, `max_tokens`
     */
    this.config = (options.config as Config) || {};
  }

  id(): string {
    return this.providerId;
  }

  async callApi(prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    console.log("Vars for this test case:", JSON.stringify(context?.vars));

    const cache = promptfoo.cache.getCache();

    await cache.set(prompt, "cached-value", 3600);
    const cachedValue = await cache.get(prompt);

    /*
     * `output` is required
     * `metadata` is for any custom data
     */
    return {
      prompt,
      output: "Model output",
      // error: "some error",
      tokenUsage: {
        total: prompt.length,
        prompt: prompt.length,
        completion: 0,
      },
      // https://www.promptfoo.dev/docs/configuration/expected-outputs/guardrails/
      // https://www.promptfoo.dev/docs/guides/testing-guardrails/
      guardrails: {
        flagged: false,
        flaggedInput: false,
        flaggedOutput: false,
        // reason: "some reason"
      },
      metadata: {},
    };
  }
}
