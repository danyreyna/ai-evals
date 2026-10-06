import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient, type Payment } from "./index.ts";
import { server } from "./mocks/server.ts";
import { resetPayments } from "./mocks/handlers.ts";

const client = new PaymentsClient({ apiKey: "test_key", baseUrl: "https://api.example.com/v1" });
const badClient = new PaymentsClient({ apiKey: "wrong_key", baseUrl: "https://api.example.com/v1" });

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
      throw new Error("expected the request to reject");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PaymentsApiError);
  expect((error as PaymentsApiError).status).toBe(status);
  expect((error as PaymentsApiError).code).toBe(code);
  return error as PaymentsApiError;
}

const create = (source = "tok_visa", amount = 1000): Promise<Payment> =>
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
    expect(new Date(payment.createdAt).toString()).not.toBe("Invalid Date");
  });

  test("creates a pending payment for tok_pending", async () => {
    const payment = await create("tok_pending");
    expect(payment.status).toBe("pending");
  });

  test("rejects a declined card with 402 card_declined", async () => {
    const error = await expectApiError(create("tok_chargeDeclined"), 402, "card_declined");
    expect(error.message).toBe("The card was declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(create("tok_insufficientFunds"), 402, "insufficient_funds");
  });

  test("surfaces a 500 processing_error", async () => {
    await expectApiError(create("tok_serverError"), 500, "processing_error");
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(create("tok_unknown"), 400, "invalid_source");
  });

  test.each([
    ["zero amount", 0],
    ["negative amount", -5],
    ["non-integer amount", 10.5],
  ])("rejects a %s with 400 invalid_request", async (_name, amount) => {
    await expectApiError(create("tok_visa", amount), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const promise = client.createPayment({ amount: 100, source: "tok_visa" } as never);
    await expectApiError(promise, 400, "invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const promise = badClient.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    await expectApiError(promise, 401, "unauthorized");
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

  test("url-encodes the id", async () => {
    const error = await expectApiError(client.getPayment("a/b c"), 404, "payment_not_found");
    expect(error.message).toBe("No payment with id a/b c");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.getPayment("pay_any"), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment without a filter", async () => {
    const a = await create("tok_visa");
    const b = await create("tok_pending");

    const payments = await client.listPayments();
    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([a, b]));
  });

  test("filters by status", async () => {
    const succeeded = await create("tok_visa");
    const pending = await create("tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
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
    expect(refunded).toMatchObject({ id: created.id, status: "refunded", amountRefunded: 1000 });
  });

  test("partially refunds a given amount", async () => {
    const created = await create("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });
    expect(refunded).toMatchObject({ status: "partially_refunded", amountRefunded: 400 });
  });

  test("completes a refund across several partial refunds", async () => {
    const created = await create("tok_visa", 1000);

    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id, { amount: 600 });
    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("persists the refund so getPayment reflects it", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 250 });

    expect(await client.getPayment(created.id)).toMatchObject({
      status: "partially_refunded",
      amountRefunded: 250,
    });
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
    ["non-integer", 10.5],
    ["greater than the payment amount", 1001],
  ])("rejects a refund amount that is %s with 422 invalid_refund_amount", async (_name, amount) => {
    const created = await create("tok_visa", 1000);

    await expectApiError(client.refundPayment(created.id, { amount }), 422, "invalid_refund_amount");
  });

  test("rejects a refund greater than the remaining balance with 422", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 800 });

    const error = await expectApiError(
      client.refundPayment(created.id, { amount: 300 }),
      422,
      "invalid_refund_amount",
    );
    expect(error.message).toBe("Refund amount must be between 1 and 200");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.refundPayment("pay_any"), 401, "unauthorized");
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

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.cancelPayment("pay_any"), 401, "unauthorized");
  });
});

describe("error handling", () => {
  test("falls back to unknown_error and statusText for a non-JSON error body", async () => {
    const { http, HttpResponse } = await import("msw");
    server.use(
      http.get(
        "https://api.example.com/v1/payments/pay_broken",
        () => new HttpResponse("oops", { status: 502, statusText: "Bad Gateway" }),
      ),
    );

    const error = await expectApiError(client.getPayment("pay_broken"), 502, "unknown_error");
    expect(error.message).toBe("Bad Gateway");
    expect(error.name).toBe("PaymentsApiError");
  });
});
