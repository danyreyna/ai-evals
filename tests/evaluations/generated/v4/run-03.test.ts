import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  resetPayments();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string | RegExp,
) {
  const error = await promise.then(
    () => {
      throw new Error("Expected the request to be rejected");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  if (message !== undefined) {
    if (typeof message === "string") {
      expect(apiError.message).toBe(message);
    } else {
      expect(apiError.message).toMatch(message);
    }
  }
}

const newPayment = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await newPayment("tok_visa", 2500);

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await newPayment("tok_pending");

    expect(payment.status).toBe("pending");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test.each([
    ["zero amount", { amount: 0, currency: "usd", source: "tok_visa" }],
    ["negative amount", { amount: -5, currency: "usd", source: "tok_visa" }],
    ["fractional amount", { amount: 10.5, currency: "usd", source: "tok_visa" }],
    ["missing currency", { amount: 1000, source: "tok_visa" }],
    ["missing source", { amount: 1000, currency: "usd" }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(
      client.createPayment(input as Parameters<typeof client.createPayment>[0]),
      400,
      "invalid_request",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      newPayment("tok_unknown"),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      newPayment("tok_chargeDeclined"),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      newPayment("tok_insufficientFunds"),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    await expectApiError(
      newPayment("tok_serverError"),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(newPayment("tok_chargeDeclined"), 402, "card_declined");

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await newPayment("tok_visa", 4200);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment();

    await expectApiError(badKeyClient.getPayment(created.id), 401, "unauthorized");
  });

  test("url-encodes the id in the request path", async () => {
    await expectApiError(
      client.getPayment("a/b c"),
      404,
      "payment_not_found",
      "No payment with id a/b c",
    );
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const first = await newPayment("tok_visa");
    const second = await newPayment("tok_pending");

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await newPayment("tok_visa");
    const pending = await newPayment("tok_pending");

    const onlySucceeded = await client.listPayments({ status: "succeeded" });
    const onlyPending = await client.listPayments({ status: "pending" });
    const onlyCanceled = await client.listPayments({ status: "canceled" });

    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);
    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);
    expect(onlyCanceled).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment when no amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.id).toBe(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds a succeeded payment", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("refunds the remainder of a partially refunded payment", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment();

    await expectApiError(badKeyClient.refundPayment(created.id), 401, "unauthorized");
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects a refund larger than the payment with 422 invalid_refund_amount", async () => {
    const created = await newPayment("tok_visa", 1000);

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("rejects a refund larger than the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 300",
    );
  });

  test.each([0, -10, 12.5])(
    "rejects refund amount %p with 422 invalid_refund_amount",
    async (amount) => {
      const created = await newPayment("tok_visa", 1000);

      await expectApiError(
        client.refundPayment(created.id, { amount }),
        422,
        "invalid_refund_amount",
      );
    },
  );
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment("tok_pending");

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
  });

  test("persists the cancellation so getPayment reflects it", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment("tok_pending");

    await expectApiError(badKeyClient.cancelPayment(created.id), 401, "unauthorized");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_visa");

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });
});

describe("error fallbacks", () => {
  test("falls back to unknown_error and statusText when the error body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("upstream failure", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), 502, "unknown_error", "Bad Gateway");
  });
});

describe("request shape", () => {
  test("sends the bearer token and JSON body on create", async () => {
    let authorization: string | null = null;
    let contentType: string | null = null;
    let body: unknown;
    server.use(
      http.post(`${BASE_URL}/payments`, async ({ request }) => {
        authorization = request.headers.get("Authorization");
        contentType = request.headers.get("Content-Type");
        body = await request.json();
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" });

    expect(authorization).toBe("Bearer test_key");
    expect(contentType).toBe("application/json");
    expect(body).toEqual({ amount: 1000, currency: "usd", source: "tok_visa" });
  });

  test("honors a custom baseUrl", async () => {
    server.use(
      http.get("https://payments.internal/v2/payments/pay_1", () =>
        HttpResponse.json({ id: "pay_1" }),
      ),
    );
    const custom = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://payments.internal/v2",
    });

    const payment = await custom.getPayment("pay_1");

    expect(payment.id).toBe("pay_1");
  });
});
