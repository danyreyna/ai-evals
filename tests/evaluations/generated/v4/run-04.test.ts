import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badKeyClient = new PaymentsClient({ apiKey: "wrong_key" });

async function rejection(promise: Promise<unknown>): Promise<PaymentsApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentsApiError);
    return error as PaymentsApiError;
  }
  throw new Error("Expected the promise to reject");
}

const newPayment = (source = "tok_visa", amount = 1000) =>
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
    const error = await rejection(newPayment("tok_chargeDeclined"));

    expect(error.status).toBe(402);
    expect(error.code).toBe("card_declined");
    expect(error.message).toBe("The card was declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    const error = await rejection(newPayment("tok_insufficientFunds"));

    expect(error.status).toBe(402);
    expect(error.code).toBe("insufficient_funds");
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    const error = await rejection(newPayment("tok_serverError"));

    expect(error.status).toBe(500);
    expect(error.code).toBe("processing_error");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    const error = await rejection(newPayment("tok_unknown"));

    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_source");
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    const error = await rejection(newPayment("tok_visa", amount));

    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_request");
  });

  test("rejects a missing field with 400 invalid_request", async () => {
    const incomplete = { amount: 100, currency: "usd" } as unknown as Parameters<
      typeof client.createPayment
    >[0];

    const error = await rejection(client.createPayment(incomplete));

    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const error = await rejection(
      badKeyClient.createPayment({ amount: 100, currency: "usd", source: "tok_visa" }),
    );

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });
});

describe("getPayment", () => {
  test("retrieves a created payment by id", async () => {
    const created = await newPayment();

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await rejection(client.getPayment("pay_missing"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
    expect(error.message).toContain("pay_missing");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment();

    const error = await rejection(badKeyClient.getPayment(created.id));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when no payments exist", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const first = await newPayment("tok_visa");
    const second = await newPayment("tok_pending");

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([first, second]));
  });

  test("filters payments by status", async () => {
    const succeeded = await newPayment("tok_visa");
    const pending = await newPayment("tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const error = await rejection(badKeyClient.listPayments());

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds a succeeded payment when no amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds a payment", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("completes a refund across two partial refunds", async () => {
    const created = await newPayment("tok_visa", 1000);

    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 250 });

    expect(await client.getPayment(created.id)).toMatchObject({
      status: "partially_refunded",
      amountRefunded: 250,
    });
  });

  test("rejects refunding a fully refunded payment with 409 already_refunded", async () => {
    const created = await newPayment();
    await client.refundPayment(created.id);

    const error = await rejection(client.refundPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("already_refunded");
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");

    const error = await rejection(client.refundPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_refundable");
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    const error = await rejection(client.refundPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_refundable");
  });

  test("rejects a refund above the remaining amount with 422 invalid_refund_amount", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 800 });

    const error = await rejection(client.refundPayment(created.id, { amount: 300 }));

    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid_refund_amount");
    expect(error.message).toContain("200");
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await newPayment("tok_visa", 1000);

    const error = await rejection(client.refundPayment(created.id, { amount }));

    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid_refund_amount");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await rejection(client.refundPayment("pay_missing"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment();

    const error = await rejection(badKeyClient.refundPayment(created.id));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment("tok_pending");

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
    expect(await client.getPayment(created.id)).toMatchObject({ status: "canceled" });
  });

  test("rejects canceling a succeeded payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_visa");

    const error = await rejection(client.cancelPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_cancelable");
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await newPayment("tok_pending");
    await client.cancelPayment(created.id);

    const error = await rejection(client.cancelPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_cancelable");
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    const error = await rejection(client.cancelPayment("pay_missing"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await newPayment("tok_pending");

    const error = await rejection(badKeyClient.cancelPayment(created.id));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
  });
});
