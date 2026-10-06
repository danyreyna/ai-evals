import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
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
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

const validInput = { amount: 5000, currency: "usd", source: "tok_visa" };

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
}

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await client.createPayment(validInput);

    expect(payment).toMatchObject({
      amount: 5000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(payment.status).toBe("pending");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.createPayment(validInput), 401, "unauthorized");
  });

  test.each([
    ["zero amount", { ...validInput, amount: 0 }],
    ["negative amount", { ...validInput, amount: -100 }],
    ["fractional amount", { ...validInput, amount: 10.5 }],
    ["missing currency", { amount: 100, source: "tok_visa" }],
    ["missing source", { amount: 100, currency: "usd" }],
  ])("rejects %s with 400 invalid_request", async (_name, input) => {
    await expectApiError(
      client.createPayment(input as Parameters<PaymentsClient["createPayment"]>[0]),
      400,
      "invalid_request",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_unknown" }),
      400,
      "invalid_source",
    );
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...validInput, source: "tok_serverError" }),
      500,
      "processing_error",
    );
  });

  test("does not store a payment when creation fails", async () => {
    await client.createPayment({ ...validInput, source: "tok_chargeDeclined" }).catch(() => {});

    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("retrieves a created payment", async () => {
    const created = await client.createPayment(validInput);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
  });

  test("URL-encodes the id", async () => {
    await expectApiError(client.getPayment("pay/with space"), 404, "payment_not_found");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await client.createPayment(validInput);
    const b = await client.createPayment({ ...validInput, source: "tok_pending" });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment by default", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 5000,
    });
  });

  test("partially refunds a payment", async () => {
    const created = await client.createPayment(validInput);

    const refunded = await client.refundPayment(created.id, { amount: 1500 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(1500);
  });

  test("completes a refund across multiple partial refunds", async () => {
    const created = await client.createPayment(validInput);

    await client.refundPayment(created.id, { amount: 2000 });
    const refunded = await client.refundPayment(created.id, { amount: 3000 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(5000);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
    ["greater than the payment amount", 5001],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await client.createPayment(validInput);

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a refund exceeding the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 4000 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });

    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(validInput);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });
});
