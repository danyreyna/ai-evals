import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsClient } from "./index.ts";
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

const newClient = () => new PaymentsClient({ apiKey: "test_key" });
const input = { amount: 1000, currency: "usd", source: "tok_visa" };

describe("PaymentsClient happy path", () => {
  test("createPayment returns a succeeded payment", async () => {
    const payment = await newClient().createPayment(input);

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      ...input,
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("createPayment with a pending source returns a pending payment", async () => {
    const payment = await newClient().createPayment({ ...input, source: "tok_pending" });

    expect(payment.status).toBe("pending");
  });

  test("getPayment returns a previously created payment", async () => {
    const client = newClient();
    const created = await client.createPayment(input);

    expect(await client.getPayment(created.id)).toEqual(created);
  });

  test("listPayments returns all created payments", async () => {
    const client = newClient();
    const first = await client.createPayment(input);
    const second = await client.createPayment({ ...input, amount: 2000 });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  test("listPayments returns an empty array when there are no payments", async () => {
    expect(await newClient().listPayments()).toEqual([]);
  });

  test("listPayments filters by status", async () => {
    const client = newClient();
    const succeeded = await client.createPayment(input);
    const pending = await client.createPayment({ ...input, source: "tok_pending" });

    const onlyPending = await client.listPayments({ status: "pending" });
    const onlySucceeded = await client.listPayments({ status: "succeeded" });

    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);
  });

  test("refundPayment without an amount refunds the full payment", async () => {
    const client = newClient();
    const created = await client.createPayment(input);

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: input.amount,
    });
  });

  test("refundPayment with an amount partially refunds the payment", async () => {
    const client = newClient();
    const created = await client.createPayment(input);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("refundPayment can refund the remainder after a partial refund", async () => {
    const client = newClient();
    const created = await client.createPayment(input);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: input.amount });
  });

  test("cancelPayment cancels a pending payment", async () => {
    const client = newClient();
    const created = await client.createPayment({ ...input, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
  });
});
