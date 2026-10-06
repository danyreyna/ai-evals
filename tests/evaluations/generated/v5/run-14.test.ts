import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  resetPayments();
});
afterAll(() => {
  server.close();
});

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  const error = await catchError(promise);
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  if (message !== undefined) {
    expect(apiError.message).toBe(message);
  }
}

const card = { amount: 1000, currency: "usd", source: "tok_visa" };

describe("createPayment", () => {
  test("creates a succeeded payment from a valid source", async () => {
    const payment = await client.createPayment(card);
    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...card, source: "tok_pending" });
    expect(payment.status).toBe("pending");
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await client.createPayment(card);
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_serverError" }),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...card, source: "tok_nope" }),
      400,
      "invalid_source",
      "Unknown payment source",
    );
  });

  test.each([
    ["zero amount", { ...card, amount: 0 }],
    ["negative amount", { ...card, amount: -5 }],
    ["fractional amount", { ...card, amount: 10.5 }],
  ])("rejects a %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as typeof card;
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("does not store a payment when creation fails", async () => {
    await catchError(client.createPayment({ ...card, source: "tok_chargeDeclined" }));
    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment with the given id", async () => {
    const created = await client.createPayment(card);
    const fetched = await client.getPayment(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.amount).toBe(1000);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id", async () => {
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
    const a = await client.createPayment(card);
    const b = await client.createPayment({ ...card, source: "tok_pending" });
    const list = await client.listPayments();
    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(card);
    const pending = await client.createPayment({ ...card, source: "tok_pending" });

    const onlyPending = await client.listPayments({ status: "pending" });
    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);

    const onlySucceeded = await client.listPayments({ status: "succeeded" });
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(card);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(card);
    const refunded = await client.refundPayment(created.id);
    expect(refunded).toMatchObject({ id: created.id, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds a given amount", async () => {
    const created = await client.createPayment(card);
    const refunded = await client.refundPayment(created.id, { amount: 400 });
    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("accumulates partial refunds until fully refunded", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 400 });
    const final = await client.refundPayment(created.id, { amount: 600 });
    expect(final).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("refunds the remainder after a partial refund when no amount is given", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 250 });
    const final = await client.refundPayment(created.id);
    expect(final).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 100 });
    const fetched = await client.getPayment(created.id);
    expect(fetched).toMatchObject({ status: "partially_refunded", amountRefunded: 100 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);
    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);
    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(card);
    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("rejects an amount above what remains after a partial refund", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id, { amount: 700 });
    await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 300",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(card);
    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("does not change the payment when a refund is rejected", async () => {
    const created = await client.createPayment(card);
    await catchError(client.refundPayment(created.id, { amount: 5000 }));
    const fetched = await client.getPayment(created.id);
    expect(fetched).toMatchObject({ status: "succeeded", amountRefunded: 0 });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    const canceled = await client.cancelPayment(created.id);
    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
  });

  test("persists the cancellation", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(card);
    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({ ...card, source: "tok_pending" });
    await client.cancelPayment(created.id);
    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(card);
    await client.refundPayment(created.id);
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });
});

describe("authentication", () => {
  const bad = new PaymentsClient({ apiKey: "wrong_key" });

  test.each([
    ["createPayment", () => bad.createPayment(card)],
    ["getPayment", () => bad.getPayment("pay_1")],
    ["listPayments", () => bad.listPayments()],
    ["refundPayment", () => bad.refundPayment("pay_1")],
    ["cancelPayment", () => bad.cancelPayment("pay_1")],
  ])("%s rejects an invalid API key with 401 unauthorized", async (_name, call) => {
    await expectApiError(call(), 401, "unauthorized", "Missing or invalid API key");
  });
});

describe("error handling", () => {
  test("falls back to unknown_error and statusText when the error body is not JSON", async () => {
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_1",
        () => new HttpResponse("oops", { status: 503, statusText: "Service Unavailable" }),
      ),
    );
    await expectApiError(client.getPayment("pay_1"), 503, "unknown_error", "Service Unavailable");
  });

  test("honors a custom baseUrl", async () => {
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.get("https://other.example.com/payments", () => HttpResponse.json({ data: [] })),
    );
    const custom = new PaymentsClient({ apiKey: "test_key", baseUrl: "https://other.example.com" });
    expect(await custom.listPayments()).toEqual([]);
  });
});
