import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient, type Payment } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

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

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: BASE_URL });

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  const error = await promise.then(
    () => {
      throw new Error("Expected the call to reject with PaymentsApiError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(expected.status);
  expect(apiError.code).toBe(expected.code);
  if (expected.message !== undefined) {
    expect(apiError.message).toBe(expected.message);
  }
}

function create(overrides: Partial<{ amount: number; currency: string; source: string }> = {}) {
  return client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa", ...overrides });
}

describe("createPayment", () => {
  test("creates a succeeded payment and returns the stored fields", async () => {
    const payment = await create({ amount: 2500, currency: "eur" });

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("eur");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for the tok_pending source", async () => {
    const payment = await create({ source: "tok_pending" });
    expect(payment.status).toBe("pending");
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await create();
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("sends a bearer token and JSON body", async () => {
    let auth: string | null = null;
    let contentType: string | null = null;
    let body: unknown;
    server.use(
      http.post(`${BASE_URL}/payments`, async ({ request }) => {
        auth = request.headers.get("Authorization");
        contentType = request.headers.get("Content-Type");
        body = await request.json();
        return HttpResponse.json({}, { status: 201 });
      }),
    );

    await create({ amount: 42, currency: "usd", source: "tok_visa" });

    expect(auth).toBe("Bearer test_key");
    expect(contentType).toBe("application/json");
    expect(body).toEqual({ amount: 42, currency: "usd", source: "tok_visa" });
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(create({ source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(create({ source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(create({ source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(create({ source: "tok_bogus" }), {
      status: 400,
      code: "invalid_source",
    });
  });

  test.each([
    ["zero amount", { amount: 0 }],
    ["negative amount", { amount: -5 }],
    ["fractional amount", { amount: 10.5 }],
  ])("rejects a %s with 400 invalid_request", async (_name, overrides) => {
    await expectApiError(create(overrides), { status: 400, code: "invalid_request" });
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(create({ source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
    });
    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment with the given id", async () => {
    const created = await create({ amount: 700 });
    const fetched = await client.getPayment(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.amount).toBe(700);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id in the request path", async () => {
    let pathname = "";
    server.use(
      http.get(`${BASE_URL}/payments/:id`, ({ request }) => {
        pathname = new URL(request.url).pathname;
        return HttpResponse.json({});
      }),
    );

    await client.getPayment("a/b c");

    expect(pathname).toBe("/v1/payments/a%2Fb%20c");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await create();
    const b = await create({ source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    await create();
    const pending = await create({ source: "tok_pending" });

    const result = await client.listPayments({ status: "pending" });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(pending.id);
    expect(result[0]?.status).toBe("pending");
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await create();
    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await create({ amount: 1000 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds a given amount", async () => {
    const created = await create({ amount: 1000 });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await create({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund state", async () => {
    const created = await create({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 250 });

    const fetched: Payment = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await create();
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await create({ source: "tok_pending" });

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await create({ source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects a refund above the payment amount with 422 invalid_refund_amount", async () => {
    const created = await create({ amount: 1000 });

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects a refund above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await create({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 600 });

    await expectApiError(client.refundPayment(created.id, { amount: 401 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 400",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await create({ amount: 1000 });

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("does not change the payment when a refund is rejected", async () => {
    const created = await create({ amount: 1000 });
    await expectApiError(client.refundPayment(created.id, { amount: 5000 }), {
      status: 422,
      code: "invalid_refund_amount",
    });

    const fetched = await client.getPayment(created.id);
    expect(fetched.status).toBe("succeeded");
    expect(fetched.amountRefunded).toBe(0);
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await create({ source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await create();

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await create({ source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await create();
    await client.refundPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A refunded payment cannot be canceled",
    });
  });
});

describe("authentication", () => {
  const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

  test("rejects createPayment with an invalid key as 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      { status: 401, code: "unauthorized", message: "Missing or invalid API key" },
    );
  });

  test("rejects getPayment with an invalid key as 401 unauthorized", async () => {
    await expectApiError(badClient.getPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });

  test("rejects listPayments with an invalid key as 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), { status: 401, code: "unauthorized" });
  });

  test("rejects refundPayment with an invalid key as 401 unauthorized", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });

  test("rejects cancelPayment with an invalid key as 401 unauthorized", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error parsing fallbacks", () => {
  test("falls back to unknown_error and statusText when the body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("oops", { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () => HttpResponse.json({}, { status: 502 })),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 502,
      code: "unknown_error",
    });
  });
});
