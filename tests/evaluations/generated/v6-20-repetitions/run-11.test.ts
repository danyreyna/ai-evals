import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { http, HttpResponse } from "msw";
import { PaymentsApiError, PaymentsClient } from "./index.ts";
import type { CreatePaymentInput } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

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

const client = new PaymentsClient({ apiKey: "test_key" });

const validInput: CreatePaymentInput = { amount: 2000, currency: "usd", source: "tok_visa" };

/** Awaits a client call that must reject and returns the thrown PaymentsApiError. */
async function rejection(call: Promise<unknown>): Promise<PaymentsApiError> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentsApiError);
    return error as PaymentsApiError;
  }
  throw new Error("Expected the client call to reject, but it resolved");
}

describe("createPayment", () => {
  test("returns a succeeded payment for a valid card source", async () => {
    const payment = await client.createPayment(validInput);

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 2000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("returns a pending payment for the pending source", async () => {
    const payment = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(payment).toMatchObject({ status: "pending", amount: 2000, amountRefunded: 0 });
  });

  test("assigns a distinct id to each payment", async () => {
    const first = await client.createPayment(validInput);
    const second = await client.createPayment(validInput);

    expect(first.id).not.toBe(second.id);
  });

  test("throws 402 card_declined for a declined card", async () => {
    const error = await rejection(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
    );

    expect(error.status).toBe(402);
    expect(error.code).toBe("card_declined");
    expect(error.message).toBe("The card was declined");
  });

  test("throws 402 insufficient_funds when the card has no funds", async () => {
    const error = await rejection(
      client.createPayment({ ...validInput, source: "tok_insufficientFunds" }),
    );

    expect(error.status).toBe(402);
    expect(error.code).toBe("insufficient_funds");
    expect(error.message).toBe("The card has insufficient funds");
  });

  test("throws 500 processing_error on a server failure", async () => {
    const error = await rejection(
      client.createPayment({ ...validInput, source: "tok_serverError" }),
    );

    expect(error.status).toBe(500);
    expect(error.code).toBe("processing_error");
    expect(error.message).toBe("An error occurred while processing the payment");
  });

  test("throws 400 invalid_source for an unknown source", async () => {
    const error = await rejection(client.createPayment({ ...validInput, source: "tok_bogus" }));

    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_source");
    expect(error.message).toBe("Unknown payment source");
  });

  test.each([
    ["zero amount", { amount: 0 }],
    ["negative amount", { amount: -5 }],
    ["fractional amount", { amount: 10.5 }],
  ])("throws 400 invalid_request for a %s", async (_label, override) => {
    const error = await rejection(client.createPayment({ ...validInput, ...override }));

    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_request");
  });

  test("throws 400 invalid_request when currency is missing", async () => {
    const { currency: _currency, ...withoutCurrency } = validInput;
    const error = await rejection(
      client.createPayment(withoutCurrency as unknown as CreatePaymentInput),
    );

    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_request");
  });

  test("does not store a payment that was declined", async () => {
    const declined = await rejection(
      client.createPayment({ ...validInput, source: "tok_chargeDeclined" }),
    );
    const payments = await client.listPayments();

    expect(declined.status).toBe(402);
    expect(declined.code).toBe("card_declined");
    expect(payments).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await client.createPayment(validInput);
    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("reflects state changes made after creation", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);
    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("canceled");
    expect(fetched.id).toBe(created.id);
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    const error = await rejection(client.getPayment("pay_missing"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("url-encodes the id so a slash cannot reach another route", async () => {
    const error = await rejection(client.getPayment("a/refund"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
    expect(error.message).toBe("No payment with id a/refund");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    const payments = await client.listPayments();

    expect(payments).toEqual([]);
  });

  test("returns every payment when no filter is given", async () => {
    const first = await client.createPayment(validInput);
    const second = await client.createPayment({ ...validInput, source: "tok_pending" });
    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toContainEqual(first);
    expect(payments).toContainEqual(second);
  });

  test("returns only payments matching the status filter", async () => {
    const succeeded = await client.createPayment(validInput);
    const pending = await client.createPayment({ ...validInput, source: "tok_pending" });

    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });

  test("returns an empty array when no payment matches the filter", async () => {
    await client.createPayment(validInput);
    const payments = await client.listPayments({ status: "refunded" });

    expect(payments).toEqual([]);
  });

  test("filters on the current status after a refund", async () => {
    const created = await client.createPayment(validInput);
    const refunded = await client.refundPayment(created.id, { amount: 500 });
    const partial = await client.listPayments({ status: "partially_refunded" });
    const succeeded = await client.listPayments({ status: "succeeded" });

    expect(partial).toEqual([refunded]);
    expect(succeeded).toEqual([]);
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await client.createPayment(validInput);
    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 2000,
      amount: 2000,
    });
  });

  test("partially refunds a payment when an amount is given", async () => {
    const created = await client.createPayment(validInput);
    const refunded = await client.refundPayment(created.id, { amount: 750 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 750,
      amount: 2000,
    });
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 750 });
    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 2000 });
  });

  test("accumulates multiple partial refunds", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 500 });
    const second = await client.refundPayment(created.id, { amount: 500 });

    expect(second).toMatchObject({ status: "partially_refunded", amountRefunded: 1000 });
  });

  test("accepts a refund amount equal to the full payment amount", async () => {
    const created = await client.createPayment(validInput);
    const refunded = await client.refundPayment(created.id, { amount: 2000 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 2000 });
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    const error = await rejection(client.refundPayment("pay_missing"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("throws 409 already_refunded for a fully refunded payment", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);
    const error = await rejection(client.refundPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("already_refunded");
    expect(error.message).toBe("Payment already refunded");
  });

  test("throws 409 not_refundable for a pending payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    const error = await rejection(client.refundPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_refundable");
    expect(error.message).toBe("A pending payment cannot be refunded");
  });

  test("throws 409 not_refundable for a canceled payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);
    const error = await rejection(client.refundPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_refundable");
    expect(error.message).toBe("A canceled payment cannot be refunded");
  });

  test("throws 422 invalid_refund_amount when the amount exceeds the payment", async () => {
    const created = await client.createPayment(validInput);
    const error = await rejection(client.refundPayment(created.id, { amount: 2001 }));

    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid_refund_amount");
    expect(error.message).toBe("Refund amount must be between 1 and 2000");
  });

  test("throws 422 invalid_refund_amount when the amount exceeds the remaining balance", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id, { amount: 1500 });
    const error = await rejection(client.refundPayment(created.id, { amount: 501 }));

    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid_refund_amount");
    expect(error.message).toBe("Refund amount must be between 1 and 500");
  });

  test.each([
    ["zero", 0],
    ["negative", -100],
    ["fractional", 10.5],
  ])("throws 422 invalid_refund_amount for a %s amount", async (_label, amount) => {
    const created = await client.createPayment(validInput);
    const error = await rejection(client.refundPayment(created.id, { amount }));

    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid_refund_amount");
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await client.createPayment(validInput);
    const error = await rejection(client.refundPayment(created.id, { amount: 9999 }));
    const fetched = await client.getPayment(created.id);

    expect(error.status).toBe(422);
    expect(error.code).toBe("invalid_refund_amount");
    expect(fetched).toEqual(created);
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({
      id: created.id,
      status: "canceled",
      amount: 2000,
      amountRefunded: 0,
    });
  });

  test("throws 404 payment_not_found for an unknown id", async () => {
    const error = await rejection(client.cancelPayment("pay_missing"));

    expect(error.status).toBe(404);
    expect(error.code).toBe("payment_not_found");
    expect(error.message).toBe("No payment with id pay_missing");
  });

  test("throws 409 not_cancelable for a succeeded payment", async () => {
    const created = await client.createPayment(validInput);
    const error = await rejection(client.cancelPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_cancelable");
    expect(error.message).toBe("A succeeded payment cannot be canceled");
  });

  test("throws 409 not_cancelable for an already canceled payment", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    await client.cancelPayment(created.id);
    const error = await rejection(client.cancelPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_cancelable");
    expect(error.message).toBe("A canceled payment cannot be canceled");
  });

  test("throws 409 not_cancelable for a refunded payment", async () => {
    const created = await client.createPayment(validInput);
    await client.refundPayment(created.id);
    const error = await rejection(client.cancelPayment(created.id));

    expect(error.status).toBe(409);
    expect(error.code).toBe("not_cancelable");
    expect(error.message).toBe("A refunded payment cannot be canceled");
  });
});

describe("authentication", () => {
  const badClient = new PaymentsClient({ apiKey: "wrong_key" });
  const unauthorizedMessage = "Missing or invalid API key";

  test("createPayment throws 401 unauthorized with an invalid key", async () => {
    const error = await rejection(badClient.createPayment(validInput));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(error.message).toBe(unauthorizedMessage);
  });

  test("getPayment throws 401 unauthorized with an invalid key", async () => {
    const created = await client.createPayment(validInput);
    const error = await rejection(badClient.getPayment(created.id));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(error.message).toBe(unauthorizedMessage);
  });

  test("listPayments throws 401 unauthorized with an invalid key", async () => {
    const error = await rejection(badClient.listPayments());

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(error.message).toBe(unauthorizedMessage);
  });

  test("refundPayment throws 401 unauthorized with an invalid key", async () => {
    const created = await client.createPayment(validInput);
    const error = await rejection(badClient.refundPayment(created.id));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(error.message).toBe(unauthorizedMessage);
  });

  test("cancelPayment throws 401 unauthorized with an invalid key", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    const error = await rejection(badClient.cancelPayment(created.id));

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(error.message).toBe(unauthorizedMessage);
  });

  test("does not mutate a payment when the key is invalid", async () => {
    const created = await client.createPayment({ ...validInput, source: "tok_pending" });
    const error = await rejection(badClient.cancelPayment(created.id));
    const fetched = await client.getPayment(created.id);

    expect(error.status).toBe(401);
    expect(error.code).toBe("unauthorized");
    expect(fetched.status).toBe("pending");
  });
});

describe("unexpected error bodies", () => {
  test("falls back to unknown_error and statusText when the body is not JSON", async () => {
    server.use(
      http.get("https://api.example.com/v1/payments/pay_x", () => {
        return new HttpResponse("Bad Gateway", { status: 502, statusText: "Bad Gateway" });
      }),
    );
    const error = await rejection(client.getPayment("pay_x"));

    expect(error.status).toBe(502);
    expect(error.code).toBe("unknown_error");
    expect(error.message).toBe("Bad Gateway");
  });
});
