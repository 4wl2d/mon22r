import type { Category, CategorySpend, CurrencyTotals } from "@mon22r/domain";
import { getCategories, getMonth, type MonthView } from "./api";
import { formatMinor, formatRateDate, type MonthPoint, monthKey } from "./format";
import { categoryLabel, MonthSwitcher, Status, useResource } from "./ui";

export function MonthScreen({ point, onChange }: { point: MonthPoint; onChange: (point: MonthPoint) => void }) {
  const key = monthKey(point);
  const { resource, reload } = useResource(key, () => loadMonth(key), "Не удалось загрузить месяц.");

  return (
    <section>
      <h1>Месяц</h1>
      <MonthSwitcher point={point} onChange={onChange} />
      {resource.status === "loading" ? <Status text="Загрузка." /> : null}
      {resource.status === "error" ? (
        <Status text={resource.message} action={{ label: "Повторить", onClick: reload }} />
      ) : null}
      {resource.status === "ready" ? (
        <MonthBody view={resource.data.view} categories={resource.data.categories} />
      ) : null}
    </section>
  );
}

function MonthBody({ view, categories }: { view: MonthView; categories: readonly Category[] }) {
  const currencies = currencyOrder(view);
  return (
    <>
      {currencies.length === 0 ? <p>В этом месяце движений нет.</p> : null}
      {currencies.map((currency) => (
        <CurrencyBlock
          key={currency}
          currency={currency}
          totals={view.totalsByCurrency.find((row) => row.currency === currency) ?? null}
          spend={view.categorySpend.filter((row) => row.currency === currency)}
          categories={categories}
        />
      ))}
      {view.estimateInHomeCurrency ? <p className="estimate">{estimateLine(view.estimateInHomeCurrency)}</p> : null}
    </>
  );
}

function CurrencyBlock({
  currency,
  totals,
  spend,
  categories,
}: {
  currency: string;
  totals: CurrencyTotals | null;
  spend: readonly CategorySpend[];
  categories: readonly Category[];
}) {
  const peak = spend.reduce((max, row) => Math.max(max, row.spentMinor), 0);
  return (
    <section className="currency-block">
      <h2 className="currency">{currency}</h2>
      {totals ? (
        <dl className="totals">
          <div>
            <dt>пришло</dt>
            <dd>{formatMinor(totals.incomeMinor, currency)}</dd>
          </div>
          <div>
            <dt>ушло</dt>
            <dd>{formatMinor(totals.expenseMinor, currency)}</dd>
          </div>
          <div>
            <dt>осталось</dt>
            <dd>{formatMinor(totals.incomeMinor - totals.expenseMinor, currency)}</dd>
          </div>
        </dl>
      ) : null}
      {spend.length > 0 ? (
        <ul className="categories">
          {spend.map((row) => {
            const width = peak > 0 && row.spentMinor > 0 ? (row.spentMinor / peak) * 100 : 0;
            return (
              <li key={row.categoryId ?? "none"} className="category">
                <span>{categoryLabel(categories, row.categoryId)}</span>
                <span>{formatMinor(row.spentMinor, currency)}</span>
                <div className="track" aria-hidden="true">
                  <span style={{ width: `${width}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function estimateLine(estimate: MonthView["estimateInHomeCurrency"] & object): string {
  const amount = `оценка ${formatMinor(estimate.minor, estimate.currency)}`;
  return estimate.asOf ? `${amount} · курс ${formatRateDate(estimate.asOf)}` : amount;
}

function currencyOrder(view: MonthView): string[] {
  const codes: string[] = [];
  for (const row of view.totalsByCurrency) {
    if (!codes.includes(row.currency)) codes.push(row.currency);
  }
  for (const row of view.categorySpend) {
    if (!codes.includes(row.currency)) codes.push(row.currency);
  }
  return codes;
}

async function loadMonth(month: string): Promise<{ view: MonthView; categories: readonly Category[] }> {
  const [view, categories] = await Promise.all([getMonth(month), getCategories()]);
  return { view, categories };
}
