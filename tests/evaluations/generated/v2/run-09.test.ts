import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });

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
  return error as PaymentsApiError;
}

const create = (source = "tok_visa", amount = 1000) =>
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
    const payment = await create("tok_visa", 2500);

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
    const payment = await create("tok_pending");
    expect(payment.status).toBe("pending");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    const error = await expectApiError(create("tok_chargeDeclined"), 402, "card_declined");
    expect(error.message).toBe("The card was declined");
    expect(error.name).toBe("PaymentsApiError");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(create("tok_insufficientFunds"), 402, "insufficient_funds");
  });

  test("rejects a processing failure with 500 processing_error", async () => {
    await expectApiError(create("tok_serverError"), 500, "processing_error");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(create("tok_unknown"), 400, "invalid_source");
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(create("tok_visa", amount), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await create();
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments when no filter is given", async () => {
    const a = await create("tok_visa");
    const b = await create("tok_pending");

    const payments = await client.listPayments();
    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await create("tok_visa");
    const pending = await create("tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await create("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);
    expect(refunded).toMatchObject({ id: created.id, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await create("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });
    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("completes a refund across multiple partial refunds", async () => {
    const created = await create("tok_visa", 1000);

    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id, { amount: 600 });
    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await create();
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await create("tok_pending");

    const error = await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await create("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["more than the remaining balance", 1001],
  ])("rejects a refund amount of %s with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await create("tok_visa", 1000);

    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a refund larger than what remains after a partial refund", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 700 });

    const error = await expectApiError(
      client.refundPayment(created.id, { amount: 400 }),
      422,
      "invalid_refund_amount",
    );
    expect(error.message).toBe("Refund amount must be between 1 and 300");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await create("tok_pending");

    const canceled = await client.cancelPayment(created.id);
    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await create("tok_visa");

    const error = await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await create("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });
});

describe("authentication", () => {
  const badClient = new PaymentsClient({ apiKey: "wrong_key" });

  test("createPayment rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
  });

  test("getPayment rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.getPayment("pay_any"), 401, "unauthorized");
  });

  test("listPayments rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });

  test("refundPayment rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), 401, "unauthorized");
  });

  test("cancelPayment rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), 401, "unauthorized");
  });
});
