import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import type { Payment } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

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

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  const error = await promise.then(
    () => {
      throw new Error("expected promise to reject with PaymentsApiError");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  const apiError = error as PaymentsApiError;
  expect(apiError.status).toBe(status);
  expect(apiError.code).toBe(code);
  if (message !== undefined) {
    expect(apiError.message).toBe(message);
  }
}

const create = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await create("tok_visa", 2500);
    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 2500,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await create("tok_pending");
    expect(payment.status).toBe("pending");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(
      create("tok_chargeDeclined"),
      402,
      "card_declined",
      "The card was declined",
    );
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      create("tok_insufficientFunds"),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("surfaces a processing failure as 500 processing_error", async () => {
    await expectApiError(
      create("tok_serverError"),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(create("tok_bogus"), 400, "invalid_source", "Unknown payment source");
  });

  test.each([0, -5, 10.5])("rejects amount %p with 400 invalid_request", async (amount) => {
    await expectApiError(create("tok_visa", amount), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const promise = client.createPayment({ amount: 100, source: "tok_visa" } as never);
    await expectApiError(promise, 400, "invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const promise = badClient.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    await expectApiError(promise, 401, "unauthorized", "Missing or invalid API key");
  });
});

describe("getPayment", () => {
  test("returns a previously created payment", async () => {
    const created = await create();
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("url-encodes the id", async () => {
    await expectApiError(
      client.getPayment("a/b c"),
      404,
      "payment_not_found",
      "No payment with id a/b c",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await create();
    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns all payments", async () => {
    const a = await create("tok_visa");
    const b = await create("tok_pending");
    const list = await client.listPayments();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id).toSorted()).toEqual([a.id, b.id].toSorted());
  });

  test("filters by status", async () => {
    const succeeded = await create("tok_visa");
    const pending = await create("tok_pending");

    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await create("tok_visa", 1000);
    const refunded = await client.refundPayment(created.id);
    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds when an amount is given", async () => {
    const created = await create("tok_visa", 1000);
    const refunded = await client.refundPayment(created.id, { amount: 400 });
    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("accumulates partial refunds until fully refunded", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id, { amount: 600 });
    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund on the stored payment", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 250 });
    const fetched: Payment = await client.getPayment(created.id);
    expect(fetched).toMatchObject({ status: "partially_refunded", amountRefunded: 250 });
  });

  test("rejects an unknown id with 404 payment_not_found", async () => {
    await expectApiError(client.refundPayment("pay_missing"), 404, "payment_not_found");
  });

  test("rejects refunding a refunded payment with 409 already_refunded", async () => {
    const created = await create();
    await client.refundPayment(created.id);
    await expectApiError(
      client.refundPayment(created.id),
      409,
      "already_refunded",
      "Payment already refunded",
    );
  });

  test("rejects refunding a pending payment with 409 not_refundable", async () => {
    const created = await create("tok_pending");
    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const created = await create("tok_pending");
    await client.cancelPayment(created.id);
    await expectApiError(
      client.refundPayment(created.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });
    await expectApiError(
      client.refundPayment(created.id, { amount: 601 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 600",
    );
  });

  test.each([0, -1, 1.5])(
    "rejects refund amount %p with 422 invalid_refund_amount",
    async (amount) => {
      const created = await create("tok_visa", 1000);
      await expectApiError(
        client.refundPayment(created.id, { amount }),
        422,
        "invalid_refund_amount",
      );
    },
  );

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await create();
    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
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
    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A succeeded payment cannot be canceled",
    );
  });

  test("rejects canceling an already canceled payment with 409 not_cancelable", async () => {
    const created = await create("tok_pending");
    await client.cancelPayment(created.id);
    await expectApiError(
      client.cancelPayment(created.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await create("tok_pending");
    await expectApiError(badClient.cancelPayment(created.id), 401, "unauthorized");
  });
});

describe("non-standard error bodies", () => {
  test("falls back to unknown_error when the error body is not JSON", async () => {
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.get("https://api.example.com/v1/payments/:id", () =>
        HttpResponse.text("Bad Gateway", { status: 502, statusText: "Bad Gateway" }),
      ),
    );
    await expectApiError(client.getPayment("pay_x"), 502, "unknown_error", "Bad Gateway");
  });
});
