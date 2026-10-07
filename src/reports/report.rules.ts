export function agingBucket(dueDate: string | null, date: string) {
  if (!dueDate) return "unknown";
  const age = Math.floor(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) /
      86400000,
  );
  if (!Number.isFinite(age)) return "unknown";
  return age <= 0
    ? "current"
    : age <= 30
      ? "days30"
      : age <= 60
        ? "days60"
        : age <= 90
          ? "days90"
          : "older";
}
