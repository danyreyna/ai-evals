import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient, type CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

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

const client = new PaymentsClient({ apiKey: "test_key" });
const input: CreatePaymentInput = { amount: 1000, currency: "usd", source: "tok_visa" };

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  const error = await promise.then(
    () => {
      throw new Error("expected promise to reject with PaymentsApiError");
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

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(input);

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
    const payment = await client.createPayment({ ...input, source: "tok_pending" });
    expect(payment.status).toBe("pending");
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await client.createPayment(input);
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(client.createPayment({ ...input, source: "tok_chargeDeclined" }), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(client.createPayment({ ...input, source: "tok_insufficientFunds" }), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
    await expectApiError(client.createPayment({ ...input, source: "tok_serverError" }), {
      status: 500,
      code: "processing_error",
      message: "An error occurred while processing the payment",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(client.createPayment({ ...input, source: "tok_nope" }), {
      status: 400,
      code: "invalid_source",
    });
  });

  test.each([
    ["zero amount", { ...input, amount: 0 }],
    ["negative amount", { ...input, amount: -5 }],
    ["fractional amount", { ...input, amount: 10.5 }],
  ])("rejects %s with 400 invalid_request", async (_name, body) => {
    await expectApiError(client.createPayment(body), { status: 400, code: "invalid_request" });
  });

  test("does not store a payment when creation fails", async () => {
    await client.createPayment({ ...input, source: "tok_chargeDeclined" }).catch(() => {});
    expect(await client.listPayments()).toEqual([]);
  });
});

describe("authentication", () => {
  const bad = new PaymentsClient({ apiKey: "wrong_key" });
  const calls: [string, (c: PaymentsClient) => Promise<unknown>][] = [
    ["createPayment", (c) => c.createPayment(input)],
    ["getPayment", (c) => c.getPayment("pay_x")],
    ["listPayments", (c) => c.listPayments()],
    ["refundPayment", (c) => c.refundPayment("pay_x")],
    ["cancelPayment", (c) => c.cancelPayment("pay_x")],
  ];

  test.each(calls)("%s rejects an invalid API key with 401 unauthorized", async (_name, call) => {
    await expectApiError(call(bad), {
      status: 401,
      code: "unauthorized",
      message: "Missing or invalid API key",
    });
  });
});

describe("getPayment", () => {
  test("returns the payment by id", async () => {
    const created = await client.createPayment(input);
    const fetched = await client.getPayment(created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.amount).toBe(1000);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id", async () => {
    await expectApiError(client.getPayment("a/b c"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b c",
    });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments when no filter is given", async () => {
    const a = await client.createPayment(input);
    const b = await client.createPayment({ ...input, source: "tok_pending" });
    const list = await client.listPayments();
    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(input);
    const pending = await client.createPayment({ ...input, source: "tok_pending" });

    const onlyPending = await client.listPayments({ status: "pending" });
    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);

    const onlySucceeded = await client.listPayments({ status: "succeeded" });
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(input);
    const refunded = await client.refundPayment(created.id);
    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await client.createPayment(input);
    const refunded = await client.refundPayment(created.id, { amount: 400 });
    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("accumulates partial refunds until fully refunded", async () => {
    const created = await client.createPayment(input);
    await client.refundPayment(created.id, { amount: 400 });
    const second = await client.refundPayment(created.id, { amount: 600 });
    expect(second).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("refunds the remainder after a partial refund when no amount is given", async () => {
    const created = await client.createPayment(input);
    await client.refundPayment(created.id, { amount: 250 });
    const refunded = await client.refundPayment(created.id);
    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(input);
    await client.refundPayment(created.id);
    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...input, source: "tok_pending" });
    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...input, source: "tok_pending" });
    await client.cancelPayment(created.id);
    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A canceled payment cannot be refunded",
    });
  });

  test.each([
    ["exceeds the remaining amount", 1001],
    ["is zero", 0],
    ["is negative", -1],
    ["is fractional", 1.5],
  ])("rejects a refund amount that %s with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(input);
    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("rejects over-refunding after a partial refund against the remaining balance", async () => {
    const created = await client.createPayment(input);
    await client.refundPayment(created.id, { amount: 700 });
    await expectApiError(client.refundPayment(created.id, { amount: 400 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 300",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...input, source: "tok_pending" });
    const canceled = await client.cancelPayment(created.id);
    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(input);
    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({ ...input, source: "tok_pending" });
    await client.cancelPayment(created.id);
    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A canceled payment cannot be canceled",
    });
  });
});
