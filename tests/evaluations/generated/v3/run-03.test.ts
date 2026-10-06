import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const unauthorizedClient = new PaymentsClient({ apiKey: "wrong_key" });

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to reject");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  expect((error as PaymentsApiError).status).toBe(status);
  expect((error as PaymentsApiError).code).toBe(code);
}

const charge = (amount = 1000, source = "tok_visa") =>
  client.createPayment({ amount, currency: "usd", source });

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
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await charge(2500);

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
    const payment = await charge(1000, "tok_pending");
    expect(payment.status).toBe("pending");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(charge(1000, "tok_chargeDeclined"), 402, "card_declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(charge(1000, "tok_insufficientFunds"), 402, "insufficient_funds");
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
    await expectApiError(charge(1000, "tok_serverError"), 500, "processing_error");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(charge(1000, "tok_unknown"), 400, "invalid_source");
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(charge(amount), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(
      unauthorizedClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await charge();
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await charge();
    await expectApiError(unauthorizedClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when nothing exists", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments without a filter", async () => {
    const a = await charge(1000);
    const b = await charge(2000, "tok_pending");

    const payments = await client.listPayments();
    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await charge(1000);
    const pending = await charge(2000, "tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(unauthorizedClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await charge(1000);
    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds when an amount is given", async () => {
    const created = await charge(1000);
    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("completes a refund across multiple partial refunds", async () => {
    const created = await charge(1000);
    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await charge(1000);
    await client.refundPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await charge(1000, "tok_pending");
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await charge(1000, "tok_pending");
    await client.cancelPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
    ["larger than the payment", 1001],
  ])(
    "rejects a refund amount that is %s with 422 invalid_refund_amount",
    async (_label, amount) => {
      const created = await charge(1000);
      await expectApiError(
        client.refundPayment(created.id, { amount }),
        422,
        "invalid_refund_amount",
      );
    },
  );

  test("rejects a refund larger than the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await charge(1000);
    await client.refundPayment(created.id, { amount: 800 });
    await expectApiError(
      client.refundPayment(created.id, { amount: 300 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await charge();
    await expectApiError(unauthorizedClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await charge(1000, "tok_pending");
    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await charge();
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await charge(1000, "tok_pending");
    await client.cancelPayment(created.id);
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await charge(1000, "tok_pending");
    await expectApiError(unauthorizedClient.cancelPayment(created.id), 401, "unauthorized");
  });
});
