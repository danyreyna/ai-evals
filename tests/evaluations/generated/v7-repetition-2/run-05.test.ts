import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const BASE_URL = "https://api.example.com/v1";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

async function expectApiError(
  call: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  const error = await call.then(
    (value) => {
      throw new Error(`expected PaymentsApiError, call resolved with ${JSON.stringify(value)}`);
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(expected.status);
  expect(apiError.code).toBe(expected.code);
  if (expected.message !== undefined) {
    expect(apiError.message).toBe(expected.message);
  }
}

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

describe("createPayment", () => {
  test("returns a succeeded payment for a valid card", async () => {
    const payment = await client.createPayment({ amount: 2500, currency: "usd", source: "tok_visa" });

    expect(payment).toEqual({
      id: expect.stringMatching(/^pay_/),
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
      createdAt: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for the pending source", async () => {
    const payment = await client.createPayment({ amount: 100, currency: "usd", source: "tok_pending" });

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(100);
    expect(payment.amountRefunded).toBe(0);
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const second = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });

    expect(first.id).not.toBe(second.id);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_chargeDeclined" }),
      { status: 402, code: "card_declined", message: "The card was declined" },
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_insufficientFunds" }),
      { status: 402, code: "insufficient_funds", message: "The card has insufficient funds" },
    );
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_serverError" }),
      {
        status: 500,
        code: "processing_error",
        message: "An error occurred while processing the payment",
      },
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_bogus" }),
      { status: 400, code: "invalid_source", message: "Unknown payment source" },
    );
  });

  test.each([0, -5, 10.5])("rejects amount %p with 400 invalid_request", async (amount) => {
    await expectApiError(client.createPayment({ amount, currency: "usd", source: "tok_visa" }), {
      status: 400,
      code: "invalid_request",
    });
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 100, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];

    await expectApiError(client.createPayment(input), { status: 400, code: "invalid_request" });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badKeyClient.createPayment({ amount: 100, currency: "usd", source: "tok_visa" }),
      { status: 401, code: "unauthorized", message: "Missing or invalid API key" },
    );
  });

  test("does not store a payment that was rejected", async () => {
    await expectApiError(
      client.createPayment({ amount: 100, currency: "usd", source: "tok_chargeDeclined" }),
      { status: 402, code: "card_declined" },
    );

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment({ amount: 900, currency: "eur", source: "tok_visa" });

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment({ amount: 900, currency: "eur", source: "tok_visa" });

    await expectApiError(badKeyClient.getPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const b = await client.createPayment({ amount: 200, currency: "usd", source: "tok_pending" });

    expect(await client.listPayments()).toEqual([a, b]);
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const pending = await client.createPayment({ amount: 200, currency: "usd", source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the status filter", async () => {
    await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badKeyClient.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toEqual({ ...created, status: "refunded", amountRefunded: 1000 });
    expect(await client.getPayment(created.id)).toEqual(refunded);
  });

  test("partially refunds a payment when an amount is given", async () => {
    const created = await client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toEqual({ ...created, status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" });
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("moves to refunded when partial refunds add up to the full amount", async () => {
    const created = await client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" });
    const first = await client.refundPayment(created.id, { amount: 400 });
    const second = await client.refundPayment(created.id, { amount: 600 });

    expect(first.status).toBe("partially_refunded");
    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(1000);
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" });
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ amount: 1000, currency: "usd", source: "tok_pending" });

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ amount: 1000, currency: "usd", source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test("rejects an amount above the payment with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" });

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" });
    await client.refundPayment(created.id, { amount: 700 });

    await expectApiError(client.refundPayment(created.id, { amount: 400 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 300",
    });
  });

  test.each([0, -1, 1.5])("rejects refund amount %p with 422 invalid_refund_amount", async (amount) => {
    const created = await client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" });

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" });

    await expectApiError(badKeyClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ amount: 500, currency: "usd", source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toEqual({ ...created, status: "canceled" });
    expect(await client.getPayment(created.id)).toEqual(canceled);
  });

  test("rejects a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({ amount: 500, currency: "usd", source: "tok_visa" });

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({ amount: 500, currency: "usd", source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment({ amount: 500, currency: "usd", source: "tok_pending" });

    await expectApiError(badKeyClient.cancelPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("error responses the mock does not model", () => {
  test("falls back to unknown_error and the status text when the body is not JSON", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments/:id`,
        () => new HttpResponse("upstream down", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    await expectApiError(client.getPayment("pay_any"), {
      status: 502,
      code: "unknown_error",
      message: "Bad Gateway",
    });
  });

  test("falls back to unknown_error when the JSON body has no error object", async () => {
    server.use(
      http.get(
        `${BASE_URL}/payments`,
        () => HttpResponse.json({ oops: true }, { status: 503, statusText: "Service Unavailable" }),
      ),
    );

    await expectApiError(client.listPayments(), {
      status: 503,
      code: "unknown_error",
      message: "Service Unavailable",
    });
  });
});
