import type {
  ApiProvider,
  CallApiContextParams,
  ProviderOptions,
  ProviderResponse,
} from "promptfoo";

type Config = Record<string, string | number>;
export default class CustomApiProvider implements ApiProvider {
  protected providerId: string;
  public config: Config;

  constructor(options: ProviderOptions) {
    this.providerId = options.id || "custom provider";

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

    /*
     * `output` is required
     */
    return {
      prompt,
      output: "Model output",
      tokenUsage: {
        total: 10,
        prompt: 5,
        completion: 5,
      },
    };
  }
}
