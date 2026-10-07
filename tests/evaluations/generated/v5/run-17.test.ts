import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const input = { amount: 1000, currency: "usd", source: "tok_visa" };

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => {
      throw new Error("expected PaymentsApiError, but the call resolved");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  return apiError;
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
  test("creates a succeeded payment", async () => {
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

  test("402 card_declined", async () => {
    const error = await expectApiError(
      client.createPayment({ ...input, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
    expect(error.message).toBe("The card was declined");
  });

  test("402 insufficient_funds", async () => {
    await expectApiError(
      client.createPayment({ ...input, source: "tok_insufficientFunds" }),
      402,
      "insufficient_funds",
    );
  });

  test("500 processing_error", async () => {
    await expectApiError(
      client.createPayment({ ...input, source: "tok_serverError" }),
      500,
      "processing_error",
    );
  });

  test("400 invalid_source for an unknown source", async () => {
    await expectApiError(
      client.createPayment({ ...input, source: "tok_nope" }),
      400,
      "invalid_source",
    );
  });

  test.each([0, -5, 10.5])("400 invalid_request for amount %p", async (amount) => {
    await expectApiError(client.createPayment({ ...input, amount }), 400, "invalid_request");
  });

  test("does not store a payment when creation fails", async () => {
    await expectApiError(
      client.createPayment({ ...input, source: "tok_chargeDeclined" }),
      402,
      "card_declined",
    );
    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the created payment", async () => {
    const created = await client.createPayment(input);
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("404 payment_not_found for an unknown id", async () => {
    const error = await expectApiError(client.getPayment("pay_missing"), 404, "payment_not_found");
    expect(error.message).toContain("pay_missing");
  });

  test("encodes the id in the URL path", async () => {
    await expectApiError(client.getPayment("a/b"), 404, "payment_not_found");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await client.createPayment(input);
    const b = await client.createPayment({ ...input, source: "tok_pending" });

    const list = await client.listPayments();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await client.createPayment(input);
    const pending = await client.createPayment({ ...input, source: "tok_pending" });

    const pendingList = await client.listPayments({ status: "pending" });
    expect(pendingList.map((p) => p.id)).toEqual([pending.id]);

    const succeededList = await client.listPayments({ status: "succeeded" });
    expect(succeededList.map((p) => p.id)).toEqual([succeeded.id]);

    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await client.createPayment(input);
    const refunded = await client.refundPayment(created.id);

    expect(refunded.id).toBe(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds a given amount", async () => {
    const created = await client.createPayment(input);
    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("completes a refund across two partial refunds", async () => {
    const created = await client.createPayment(input);
    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("refunds the remainder after a partial refund", async () => {
    const created = await client.createPayment(input);
    await client.refundPayment(created.id, { amount: 300 });
    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund", async () => {
    const created = await client.createPayment(input);
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);
    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });

  test("404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("409 already_refunded for a fully refunded payment", async () => {
    const created = await client.createPayment(input);
    await client.refundPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "already_refunded");
  });

  test("409 not_refundable for a pending payment", async () => {
    const created = await client.createPayment({ ...input, source: "tok_pending" });
    const error = await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
    expect(error.message).toContain("pending");
  });

  test("409 not_refundable for a canceled payment", async () => {
    const created = await client.createPayment({ ...input, source: "tok_pending" });
    await client.cancelPayment(created.id);
    await expectApiError(client.refundPayment(created.id), 409, "not_refundable");
  });

  test("422 invalid_refund_amount when exceeding the remaining amount", async () => {
    const created = await client.createPayment(input);
    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
    );
  });

  test("422 invalid_refund_amount when exceeding what is left after a partial refund", async () => {
    const created = await client.createPayment(input);
    await client.refundPayment(created.id, { amount: 800 });
    await expectApiError(
      client.refundPayment(created.id, { amount: 201 }),
      422,
      "invalid_refund_amount",
    );
  });

  test.each([0, -1, 1.5])("422 invalid_refund_amount for amount %p", async (amount) => {
    const created = await client.createPayment(input);
    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("a rejected refund leaves the payment unchanged", async () => {
    const created = await client.createPayment(input);
    await expectApiError(
      client.refundPayment(created.id, { amount: 5000 }),
      422,
      "invalid_refund_amount",
    );

    const fetched = await client.getPayment(created.id);
    expect(fetched.status).toBe("succeeded");
    expect(fetched.amountRefunded).toBe(0);
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...input, source: "tok_pending" });
    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });

  test("404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), 404, "payment_not_found");
  });

  test("409 not_cancelable for a succeeded payment", async () => {
    const created = await client.createPayment(input);
    const error = await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
    expect(error.message).toContain("succeeded");
  });

  test("409 not_cancelable for an already canceled payment", async () => {
    const created = await client.createPayment({ ...input, source: "tok_pending" });
    await client.cancelPayment(created.id);
    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });
});

describe("authentication", () => {
  const bad = new PaymentsClient({ apiKey: "wrong_key" });

  test("401 unauthorized on createPayment", async () => {
    await expectApiError(bad.createPayment(input), 401, "unauthorized");
  });

  test("401 unauthorized on getPayment", async () => {
    await expectApiError(bad.getPayment("pay_any"), 401, "unauthorized");
  });

  test("401 unauthorized on listPayments", async () => {
    await expectApiError(bad.listPayments(), 401, "unauthorized");
  });

  test("401 unauthorized on refundPayment", async () => {
    await expectApiError(bad.refundPayment("pay_any"), 401, "unauthorized");
  });

  test("401 unauthorized on cancelPayment", async () => {
    await expectApiError(bad.cancelPayment("pay_any"), 401, "unauthorized");
  });

  test("401 takes precedence over 404", async () => {
    const created = await client.createPayment(input);
    await expectApiError(bad.getPayment(created.id), 401, "unauthorized");
  });
});
