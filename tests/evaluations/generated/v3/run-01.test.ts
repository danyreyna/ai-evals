import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

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

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error("expected the request to be rejected");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
}

const newPayment = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await newPayment();
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
    const payment = await newPayment("tok_pending");
    expect(payment.status).toBe("pending");
  });

  test("rejects an invalid amount with 400 invalid_request", async () => {
    await expectApiError(newPayment("tok_visa", 0), 400, "invalid_request");
  });

  test("rejects a non-integer amount with 400 invalid_request", async () => {
    await expectApiError(newPayment("tok_visa", 10.5), 400, "invalid_request");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(newPayment("tok_unknown"), 400, "invalid_source");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(newPayment("tok_chargeDeclined"), 402, "card_declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(newPayment("tok_insufficientFunds"), 402, "insufficient_funds");
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    await expectApiError(newPayment("tok_serverError"), 500, "processing_error");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
    );
  });
});

describe("getPayment", () => {
  test("returns a created payment", async () => {
    const created = await newPayment();
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.getPayment("pay_any"), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await newPayment();
    const b = await newPayment("tok_pending");
    const list = await client.listPayments();
    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters payments by status", async () => {
    const succeeded = await newPayment();
    const pending = await newPayment("tok_pending");

    const onlyPending = await client.listPayments({ status: "pending" });
    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);

    const onlySucceeded = await client.listPayments({ status: "succeeded" });
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await newPayment();
    const refunded = await client.refundPayment(created.id);
    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds and then refunds the remainder", async () => {
    const created = await newPayment();

    const partial = await client.refundPayment(created.id, { amount: 400 });
    expect(partial).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });

    const rest = await client.refundPayment(created.id, { amount: 600 });
    expect(rest).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("returns 409 already_refunded for a fully refunded payment", async () => {
    const created = await newPayment();
    await client.refundPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("returns 409 not_refundable for a pending payment", async () => {
    const created = await newPayment("tok_pending");
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("returns 409 not_refundable for a canceled payment", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("returns 422 invalid_refund_amount when exceeding the remaining amount", async () => {
    const created = await newPayment();
    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("returns 422 invalid_refund_amount for a zero amount", async () => {
    const created = await newPayment();
    await expectApiError(
      client.refundPayment(created.id, { amount: 0 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("returns 422 invalid_refund_amount for a non-integer amount", async () => {
    const created = await newPayment();
    await expectApiError(
      client.refundPayment(created.id, { amount: 1.5 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment("tok_pending");
    const canceled = await client.cancelPayment(created.id);
    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("returns 409 not_cancelable for a succeeded payment", async () => {
    const created = await newPayment();
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("returns 409 not_cancelable for an already canceled payment", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), 401, "unauthorized");
  });
});
