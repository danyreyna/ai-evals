import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });

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

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to be rejected");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  expect(error).toMatchObject({ name: "PaymentsApiError", status, code });
  expect((error as PaymentsApiError).message.length).toBeGreaterThan(0);
}

const newPayment = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await newPayment("tok_visa", 2500);

    expect(payment).toMatchObject({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await newPayment("tok_pending");
    expect(payment.status).toBe("pending");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(newPayment("tok_chargeDeclined"), 402, "card_declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(newPayment("tok_insufficientFunds"), 402, "insufficient_funds");
  });

  test("surfaces a 500 processing_error", async () => {
    await expectApiError(newPayment("tok_serverError"), 500, "processing_error");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(newPayment("tok_unknown"), 400, "invalid_source");
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(newPayment("tok_visa", amount), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 100, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(
      bad.createPayment({ amount: 100, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await newPayment();
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
  });

  test("url-encodes the id", async () => {
    await expectApiError(client.getPayment("a/b?c"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment();
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments without a filter", async () => {
    const a = await newPayment("tok_visa");
    const b = await newPayment("tok_pending");

    const list = await client.listPayments();

    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    await newPayment("tok_visa");
    const pending = await newPayment("tok_pending");

    const list = await client.listPayments({ status: "pending" });

    expect(list).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await newPayment("tok_visa");
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects refunding an already refunded payment with 409 already_refunded", async () => {
    const created = await newPayment();
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["above the remaining balance", 1001],
  ])("rejects a %s amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await newPayment("tok_visa", 1000);
    await expectApiError(client.refundPayment(created.id, { amount }), 422, "invalid_refund_amount");
  });

  test("rejects a refund above what remains after a partial refund", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 800 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 300 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment();
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment("tok_pending");

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_visa");
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment("tok_pending");
    const bad = new PaymentsClient({ apiKey: "wrong_key" });
    await expectApiError(bad.cancelPayment(created.id), 401, "unauthorized");
  });
});
