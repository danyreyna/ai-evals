import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

beforeAll(() => {
  server.listen();
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

const visa = { amount: 1000, currency: "usd", source: "tok_visa" };
const pending = { amount: 1000, currency: "usd", source: "tok_pending" };

describe("createPayment", () => {
  test("creates a succeeded payment for tok_visa", async () => {
    const payment = await client.createPayment(visa);

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
    const payment = await client.createPayment(pending);

    expect(payment.status).toBe("pending");
  });

  test("rejects an invalid amount with 400 invalid_request", async () => {
    await expectApiError(client.createPayment({ ...visa, amount: 0 }), 400, "invalid_request");
    await expectApiError(client.createPayment({ ...visa, amount: -5 }), 400, "invalid_request");
    await expectApiError(client.createPayment({ ...visa, amount: 10.5 }), 400, "invalid_request");
  });

  test("rejects missing fields with 400 invalid_request", async () => {
    const input = { amount: 1000, currency: "usd" } as unknown as typeof visa;

    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(
      client.createPayment({ ...visa, source: "tok_unknown" }),
      400,
      "invalid_source",
    );
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badClient.createPayment(visa), 401, "unauthorized");
  });

  test("maps tok_chargeDeclined to 402 card_declined", async () => {
    await expectApiError(
      client.createPayment({ ...visa, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
  });

  test("maps tok_insufficientFunds to 402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...visa, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
  });

  test("maps tok_serverError to 500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...visa, source: "tok_serverError" }),
      500,
      "processing_error",
    );
  });
});

describe("getPayment", () => {
  test("returns a created payment", async () => {
    const created = await client.createPayment(visa);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when no payments exist", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all created payments", async () => {
    const a = await client.createPayment(visa);
    const b = await client.createPayment(pending);

    const payments = await client.listPayments();

    expect(payments.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(visa);
    const waiting = await client.createPayment(pending);

    const onlyPending = await client.listPayments({ status: "pending" });
    const onlySucceeded = await client.listPayments({ status: "succeeded" });
    const onlyCanceled = await client.listPayments({ status: "canceled" });

    expect(onlyPending.map((p) => p.id)).toEqual([waiting.id]);
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);
    expect(onlyCanceled).toEqual([]);
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(visa);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds and then refunds the remainder", async () => {
    const created = await client.createPayment(visa);

    const partial = await client.refundPayment(created.id, { amount: 400 });
    expect(partial.status).toBe("partially_refunded");
    expect(partial.amountRefunded).toBe(400);

    const rest = await client.refundPayment(created.id);
    expect(rest.status).toBe("refunded");
    expect(rest.amountRefunded).toBe(1000);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });

  test("rejects a second full refund with 409 already_refunded", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects a zero or negative amount with 422 invalid_refund_amount", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
    await expectApiError(
      client.refundPayment(created.id, { amount: -1 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects an amount above what remains after a partial refund with 422", async () => {
    const created = await client.createPayment(visa);
    await client.refundPayment(created.id, { amount: 900 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 200 }),
      422,
      "invalid_refund_amount",
    );
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment(pending);

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects a bad API key with 401 unauthorized", async () => {
    const created = await client.createPayment(pending);

    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(visa);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await client.createPayment(pending);
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });
});
