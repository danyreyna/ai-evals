import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: BASE_URL });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: BASE_URL });

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

async function captureError(promise: Promise<unknown>): Promise<PaymentsApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentsApiError);
    return error as PaymentsApiError;
  }
  throw new Error("Expected the promise to reject with PaymentsApiError");
}

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  const error = await captureError(promise);
  expect(error.status).toBe(expected.status);
  expect(error.code).toBe(expected.code);
  if (expected.message !== undefined) {
    expect(error.message).toBe(expected.message);
  }
}

const validInput: CreatePaymentInput = { amount: 1000, currency: "usd", source: "tok_visa" };

const createSucceeded = (amount = 1000) => client.createPayment({ ...validInput, amount });
const createPending = (amount = 1000) =>
  client.createPayment({ ...validInput, amount, source: "tok_pending" });

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(validInput);

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(1000);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await createPending();
    expect(payment.status).toBe("pending");
  });

  test("returns unique ids for separate payments", async () => {
    const [a, b] = await Promise.all([createSucceeded(), createSucceeded()]);
    expect(a.id).not.toBe(b.id);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.createPayment(validInput), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(client.createPayment({ ...validInput, source: "tok_unknown" }), {
      status: 400,
      code: "invalid_source",
      message: "Unknown payment source",
    });
  });

  test.each([
    ["zero amount", { amount: 0 }],
    ["negative amount", { amount: -5 }],
    ["non-integer amount", { amount: 10.5 }],
  ])("rejects a %s with 400 invalid_request", async (_name, override) => {
    await expectApiError(client.createPayment({ ...validInput, ...override }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test.each([
    ["currency", { currency: undefined }],
    ["source", { source: undefined }],
    ["amount", { amount: undefined }],
  ])("rejects a missing %s with 400 invalid_request", async (_name, override) => {
    const input = { ...validInput, ...override } as unknown as CreatePaymentInput;
    await expectApiError(client.createPayment(input), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("does not store a payment when creation fails", async () => {
    await captureError(client.createPayment({ ...validInput, source: "tok_chargeDeclined" }));
    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await createSucceeded();
    const fetched = await client.getPayment(created.id);
    expect(fetched).toEqual(created);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createSucceeded();
    await expectApiError(badKeyClient.getPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes ids containing reserved characters", async () => {
    await expectApiError(client.getPayment("pay/with space?x=1"), {
      status: 404,
      code: "payment_not_found",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments when no filter is given", async () => {
    const a = await createSucceeded();
    const b = await createPending();
    const list = await client.listPayments();
    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    await createSucceeded();
    const pending = await createPending();

    const result = await client.listPayments({ status: "pending" });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe(pending.id);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await createSucceeded();
    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("treats an empty filter object as no filter", async () => {
    await createSucceeded();
    expect(await client.listPayments({})).toHaveLength(1);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment when no amount is given", async () => {
    const created = await createSucceeded(1000);
    const refunded = await client.refundPayment(created.id);

    expect(refunded.id).toBe(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds when an amount is given", async () => {
    const created = await createSucceeded(1000);
    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("refunds the remainder of a partially refunded payment", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("moves to refunded once partial refunds add up to the full amount", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 600 });
    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 250 });
    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createSucceeded();
    await expectApiError(badKeyClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await createSucceeded();
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await createPending();
    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects a refund larger than the payment with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(1000);
    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects a refund larger than the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await createSucceeded(1000);
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(client.refundPayment(created.id, { amount: 400 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 300",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -10],
    ["non-integer", 10.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await createSucceeded(1000);
    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("does not change the payment when a refund is rejected", async () => {
    const created = await createSucceeded(1000);
    await captureError(client.refundPayment(created.id, { amount: 5000 }));

    const fetched = await client.getPayment(created.id);
    expect(fetched.status).toBe("succeeded");
    expect(fetched.amountRefunded).toBe(0);
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await createPending();
    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
  });

  test("persists the cancellation so getPayment reflects it", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await createPending();
    await expectApiError(badKeyClient.cancelPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await createSucceeded();
    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await createPending();
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await createSucceeded();
    await client.refundPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A refunded payment cannot be canceled",
    });
  });
});

describe("error fallbacks", () => {
  test("uses unknown_error and the status text when the error body is not JSON", async () => {
    server.use(
      http.get(`${BASE_URL}/payments/:id`, () => {
        return new HttpResponse("upstream failure", { status: 502, statusText: "Bad Gateway" });
      }),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });

  test("uses unknown_error when the error body has no error object", async () => {
    server.use(
      http.get(`${BASE_URL}/payments`, () => {
        return HttpResponse.json({ detail: "nope" }, { status: 503, statusText: "Service Unavailable" });
      }),
    );

    await expectApiError(client.listPayments(), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
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

    await client.createPayment(validInput);

    expect(authorization).toBe("Bearer test_key");
    expect(contentType).toBe("application/json");
    expect(body).toEqual(validInput);
  });

  test("does not send a Content-Type header on GET requests", async () => {
    let contentType: string | null = "unset";

    server.use(
      http.get(`${BASE_URL}/payments`, ({ request }) => {
        contentType = request.headers.get("Content-Type");
        return HttpResponse.json({ data: [] });
      }),
    );

    await client.listPayments();

    expect(contentType).toBeNull();
  });
});
