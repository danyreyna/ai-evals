import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient, type Payment } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: "https://api.example.com/v1" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

async function expectApiError(
  promise: Promise<unknown>,
  expected: { status: number; code: string; message?: string },
) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PaymentsApiError);
  const error = caught as PaymentsApiError;
  expect(error.status).toBe(expected.status);
  expect(error.code).toBe(expected.code);
  if (expected.message !== undefined) {
    expect(error.message).toBe(expected.message);
  }
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

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await create("tok_pending");
    expect(payment.status).toBe("pending");
  });

  test("persists the payment so it can be retrieved", async () => {
    const created = await create();
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(create("tok_chargeDeclined"), {
      status: 402,
      code: "card_declined",
      message: "The card was declined",
    });
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(create("tok_insufficientFunds"), {
      status: 402,
      code: "insufficient_funds",
      message: "The card has insufficient funds",
    });
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
    await expectApiError(create("tok_serverError"), {
      status: 500,
      code: "processing_error",
    });
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(create("tok_bogus"), { status: 400, code: "invalid_source" });
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(create("tok_visa", amount), { status: 400, code: "invalid_request" });
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 1000, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];
    await expectApiError(client.createPayment(input), { status: 400, code: "invalid_request" });
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 1000, currency: "usd", source: "tok_visa" }),
      { status: 401, code: "unauthorized", message: "Missing or invalid API key" },
    );
  });
});

describe("getPayment", () => {
  test("returns the stored payment", async () => {
    const created = await create("tok_visa", 777);
    const fetched = await client.getPayment(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.amount).toBe(777);
    expect(fetched.status).toBe("succeeded");
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.getPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id pay_missing",
    });
  });

  test("url-encodes the id so it cannot escape the path", async () => {
    await expectApiError(client.getPayment("a/b"), {
      status: 404,
      code: "payment_not_found",
      message: "No payment with id a/b",
    });
  });

  test("returns 401 unauthorized with an invalid API key", async () => {
    const created = await create();
    await expectApiError(badClient.getPayment(created.id), { status: 401, code: "unauthorized" });
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const a = await create("tok_visa");
    const b = await create("tok_pending");

    const ids = (await client.listPayments()).map((p) => p.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  test("filters by status", async () => {
    const succeeded = await create("tok_visa");
    const pending = await create("tok_pending");

    const onlyPending = await client.listPayments({ status: "pending" });
    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);

    const onlySucceeded = await client.listPayments({ status: "succeeded" });
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await create("tok_visa");
    expect(await client.listPayments({ status: "canceled" })).toEqual([]);
  });

  test("returns 401 unauthorized with an invalid API key", async () => {
    await expectApiError(badClient.listPayments(), { status: 401, code: "unauthorized" });
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await create("tok_visa", 1000);
    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds the requested amount", async () => {
    const created = await create("tok_visa", 1000);
    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("accumulates partial refunds and ends as refunded", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });
    const second = await client.refundPayment(created.id, { amount: 600 });

    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(1000);
  });

  test("refunds the remainder after a partial refund when no amount is given", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 250 });
    const rest = await client.refundPayment(created.id);

    expect(rest.status).toBe("refunded");
    expect(rest.amountRefunded).toBe(1000);
  });

  test("reflects the refund when the payment is fetched again", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 100 });

    const fetched = await client.getPayment(created.id);
    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(100);
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.refundPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("returns 409 already_refunded for a fully refunded payment", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "already_refunded",
      message: "Payment already refunded",
    });
  });

  test("returns 409 not_refundable for a pending payment", async () => {
    const created = await create("tok_pending");

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
      message: "A pending payment cannot be refunded",
    });
  });

  test("returns 409 not_refundable for a canceled payment", async () => {
    const created = await create("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.refundPayment(created.id), {
      status: 409,
      code: "not_refundable",
    });
  });

  test("returns 422 invalid_refund_amount when exceeding the remaining amount", async () => {
    const created = await create("tok_visa", 1000);

    await expectApiError(client.refundPayment(created.id, { amount: 1001 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 1000",
    });
  });

  test("bases the refund limit on the remaining amount after a partial refund", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 900 });

    await expectApiError(client.refundPayment(created.id, { amount: 101 }), {
      status: 422,
      code: "invalid_refund_amount",
      message: "Refund amount must be between 1 and 100",
    });
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("returns 422 invalid_refund_amount for a %s amount", async (_label, amount) => {
    const created = await create("tok_visa", 1000);

    await expectApiError(client.refundPayment(created.id, { amount }), {
      status: 422,
      code: "invalid_refund_amount",
    });
  });

  test("does not change the payment when a refund is rejected", async () => {
    const created = await create("tok_visa", 1000);
    await expectApiError(client.refundPayment(created.id, { amount: 5000 }), {
      status: 422,
      code: "invalid_refund_amount",
    });

    const fetched = await client.getPayment(created.id);
    expect(fetched.status).toBe("succeeded");
    expect(fetched.amountRefunded).toBe(0);
  });

  test("returns 401 unauthorized with an invalid API key", async () => {
    const created = await create();
    await expectApiError(badClient.refundPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await create("tok_pending");
    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
  });

  test("persists the cancellation", async () => {
    const created = await create("tok_pending");
    await client.cancelPayment(created.id);

    const fetched: Payment = await client.getPayment(created.id);
    expect(fetched.status).toBe("canceled");
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(client.cancelPayment("pay_missing"), {
      status: 404,
      code: "payment_not_found",
    });
  });

  test("returns 409 not_cancelable for a succeeded payment", async () => {
    const created = await create("tok_visa");

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
      message: "A succeeded payment cannot be canceled",
    });
  });

  test("returns 409 not_cancelable when canceling twice", async () => {
    const created = await create("tok_pending");
    await client.cancelPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), {
      status: 409,
      code: "not_cancelable",
    });
  });

  test("returns 401 unauthorized with an invalid API key", async () => {
    const created = await create("tok_pending");
    await expectApiError(badClient.cancelPayment(created.id), {
      status: 401,
      code: "unauthorized",
    });
  });
});
