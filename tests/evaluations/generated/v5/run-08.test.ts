import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsApiError, PaymentsClient, type Payment } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

const client = new PaymentsClient({ apiKey: "test_key" });
const badClient = new PaymentsClient({ apiKey: "wrong_key" });

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

async function expectApiError(
  promise: Promise<unknown>,
  status: number,
  code: string,
  message?: string,
) {
  const error = await promise.then(
    () => {
      throw new Error("expected the call to reject with PaymentsApiError");
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

function create(source = "tok_visa", amount = 1000): Promise<Payment> {
  return client.createPayment({ amount, currency: "usd", source });
}

describe("createPayment", () => {
  test("creates a succeeded payment echoing the input", async () => {
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

  test("assigns distinct ids to separate payments", async () => {
    const a = await create();
    const b = await create();
    expect(a.id).not.toBe(b.id);
  });

  test("sends the bearer token and JSON body", async () => {
    let auth: string | null = null;
    let contentType: string | null = null;
    let body: unknown;
    server.events.on("request:start", async ({ request }) => {
      auth = request.headers.get("Authorization");
      contentType = request.headers.get("Content-Type");
      body = await request.clone().json();
    });

    await create("tok_visa", 700);
    server.events.removeAllListeners();

    expect(auth).toBe("Bearer test_key");
    expect(contentType).toBe("application/json");
    expect(body).toEqual({ amount: 700, currency: "usd", source: "tok_visa" });
  });

  test("rejects a declined card with 402 card_declined", async () => {
    await expectApiError(create("tok_chargeDeclined"), 402, "card_declined", "The card was declined");
  });

  test("rejects insufficient funds with 402 insufficient_funds", async () => {
    await expectApiError(
      create("tok_insufficientFunds"),
      402,
      "insufficient_funds",
      "The card has insufficient funds",
    );
  });

  test("surfaces a server failure as 500 processing_error", async () => {
    await expectApiError(
      create("tok_serverError"),
      500,
      "processing_error",
      "An error occurred while processing the payment",
    );
  });

  test("rejects an unknown source with 400 invalid_source", async () => {
    await expectApiError(create("tok_nope"), 400, "invalid_source", "Unknown payment source");
  });

  test.each([
    ["zero", 0],
    ["negative", -5],
    ["fractional", 10.5],
  ])("rejects a %s amount with 400 invalid_request", async (_label, amount) => {
    await expectApiError(create("tok_visa", amount), 400, "invalid_request");
  });

  test("rejects a missing currency with 400 invalid_request", async () => {
    const input = { amount: 100, source: "tok_visa" } as unknown as Parameters<
      typeof client.createPayment
    >[0];
    await expectApiError(client.createPayment(input), 400, "invalid_request");
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(
      badClient.createPayment({ amount: 100, currency: "usd", source: "tok_visa" }),
      401,
      "unauthorized",
      "Missing or invalid API key",
    );
  });

  test("does not store a payment when creation fails", async () => {
    await create("tok_chargeDeclined").catch(() => {});
    expect(await client.listPayments()).toEqual([]);
  });
});

describe("getPayment", () => {
  test("returns the payment that was created", async () => {
    const created = await create("tok_visa", 1234);
    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(
      client.getPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await create();
    await expectApiError(badClient.getPayment(created.id), 401, "unauthorized");
  });
});

describe("listPayments", () => {
  test("returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("returns every payment as an array", async () => {
    const a = await create("tok_visa", 100);
    const b = await create("tok_pending", 200);

    const list = await client.listPayments();

    expect(list).toHaveLength(2);
    expect(list).toContainEqual(a);
    expect(list).toContainEqual(b);
  });

  test("filters by status", async () => {
    const succeeded = await create("tok_visa");
    const pending = await create("tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
  });

  test("returns an empty array when no payment matches the status", async () => {
    await create("tok_visa");
    expect(await client.listPayments({ status: "refunded" })).toEqual([]);
  });

  test("reflects status changes in the filter", async () => {
    const pending = await create("tok_pending");
    await client.cancelPayment(pending.id);

    expect(await client.listPayments({ status: "pending" })).toEqual([]);
    const canceled = await client.listPayments({ status: "canceled" });
    expect(canceled.map((p) => p.id)).toEqual([pending.id]);
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    await expectApiError(badClient.listPayments(), 401, "unauthorized");
  });
});

describe("refundPayment", () => {
  test("fully refunds when no amount is given", async () => {
    const created = await create("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.id).toBe(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds when an amount is given", async () => {
    const created = await create("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
    expect(refunded.amount).toBe(1000);
  });

  test("accumulates partial refunds until fully refunded", async () => {
    const created = await create("tok_visa", 1000);

    const first = await client.refundPayment(created.id, { amount: 400 });
    expect(first.status).toBe("partially_refunded");

    const second = await client.refundPayment(created.id, { amount: 600 });
    expect(second.status).toBe("refunded");
    expect(second.amountRefunded).toBe(1000);
  });

  test("refunds the remaining balance after a partial refund", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 300 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("persists the refund so getPayment sees it", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });

  test("rejects refunding twice with 409 already_refunded", async () => {
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
    const pending = await create("tok_pending");
    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A pending payment cannot be refunded",
    );
  });

  test("rejects refunding a canceled payment with 409 not_refundable", async () => {
    const pending = await create("tok_pending");
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.refundPayment(pending.id),
      409,
      "not_refundable",
      "A canceled payment cannot be refunded",
    );
  });

  test("rejects an amount above the remaining balance with 422 invalid_refund_amount", async () => {
    const created = await create("tok_visa", 1000);
    await expectApiError(
      client.refundPayment(created.id, { amount: 1001 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 1000",
    );
  });

  test("rejects an amount above what remains after a partial refund", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 800 });

    await expectApiError(
      client.refundPayment(created.id, { amount: 201 }),
      422,
      "invalid_refund_amount",
      "Refund amount must be between 1 and 200",
    );
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
  ])("rejects a %s refund amount with 422 invalid_refund_amount", async (_label, amount) => {
    const created = await create("tok_visa", 1000);
    await expectApiError(
      client.refundPayment(created.id, { amount }),
      422,
      "invalid_refund_amount",
    );
  });

  test("leaves the payment unchanged after a rejected refund", async () => {
    const created = await create("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 5000 }).catch(() => {});

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(
      client.refundPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const created = await create();
    await expectApiError(badClient.refundPayment(created.id), 401, "unauthorized");
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const pending = await create("tok_pending");

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled.id).toBe(pending.id);
    expect(canceled.status).toBe("canceled");
    expect((await client.getPayment(pending.id)).status).toBe("canceled");
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

  test("rejects canceling twice with 409 not_cancelable", async () => {
    const pending = await create("tok_pending");
    await client.cancelPayment(pending.id);

    await expectApiError(
      client.cancelPayment(pending.id),
      409,
      "not_cancelable",
      "A canceled payment cannot be canceled",
    );
  });

  test("rejects canceling a refunded payment with 409 not_cancelable", async () => {
    const created = await create("tok_visa");
    await client.refundPayment(created.id);

    await expectApiError(client.cancelPayment(created.id), 409, "not_cancelable");
  });

  test("returns 404 payment_not_found for an unknown id", async () => {
    await expectApiError(
      client.cancelPayment("pay_missing"),
      404,
      "payment_not_found",
      "No payment with id pay_missing",
    );
  });

  test("rejects an invalid API key with 401 unauthorized", async () => {
    const pending = await create("tok_pending");
    await expectApiError(badClient.cancelPayment(pending.id), 401, "unauthorized");
  });
});

describe("error handling", () => {
  test("PaymentsApiError carries its name, status, and code", async () => {
    const error = await client.getPayment("pay_missing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PaymentsApiError);
    expect((error as PaymentsApiError).name).toBe("PaymentsApiError");
    expect((error as PaymentsApiError).status).toBe(404);
    expect((error as PaymentsApiError).code).toBe("payment_not_found");
  });
});
