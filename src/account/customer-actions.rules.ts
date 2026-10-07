export function frequentProductIds(
  orders: { items: { productId: string; quantity: number }[] }[],
) {
  const counts = new Map<string, number>();
  for (const order of orders)
    for (const line of order.items)
      counts.set(
        line.productId,
        (counts.get(line.productId) || 0) + line.quantity,
      );
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}
