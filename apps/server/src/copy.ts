export const text = {
  askCurrency: "Домашняя валюта: RSD, RUB, GBP или другой код ISO.",
  invalidCurrency: "Нужен код из трёх букв: RSD, RUB, GBP или другой ISO.",
  askTimeZone: "Часовой пояс. Можно оставить Europe/Belgrade.",
  invalidTimeZone: "Не вижу такой часовой пояс. Например Europe/Belgrade.",
  askAccounts: "Создать счета Поштанска RSD, Рубли RUB и UK GBP. Имена можно изменить позже.",
  needYesOrNo: "Напишите да, если создать эти счета, или нет.",
  accountsCreated: "Счета созданы.",
  accountsSkipped: "Счета не созданы.",
  unparsed: "Не разобрал. Например: кофе 350",
  undone: "Отменено.",
  nothingToUndo: "Нечего отменять.",
  alreadyUndone: "Уже отменено.",
  denied: "Нет доступа.",
  help: [
    "кофе 350",
    "+зп 180000",
    "план зп 180000 5",
    "вчера такси 1200",
    "перевод 5000 на наличные",
    "",
    "/undo снимает последнюю запись.",
  ].join("\n"),
  needCsv: "Пока читаю только CSV.",
  fileTooBig: "Файл слишком большой.",
  fileUnreadable: "Не смог прочитать файл.",
  fileFirst: "Сначала пришлите файл.",
  columnsMissing: "В заголовке нет такой колонки.",
  profileSaved: "Профиль сохранён. Пришлите файл ещё раз.",
  profileBad: "Нужна строка: имя | date=колонка | amount=колонка | description=колонка | currency=RSD",
  sameAccount: "Нужен другой счёт.",
  setupFirst: "Сначала домашняя валюта и часовой пояс.",
  importEmpty: "В файле нет строк.",
  mixedCurrency: "В файле несколько валют.",
  accountChoice: "Какой счёт?",
  nothingNew: "Новых строк нет.",
  closed: "Строка закрыта.",
  alreadyClosed: "Строка уже закрыта.",
  noAccount: (currency: string) => `Нет счёта в ${currency}.`,
  noDestination: (name: string) => `Нет счёта «${name}».`,
  currencyMismatch: (name: string, accountCurrency: string, amountCurrency: string) =>
    `Счёт «${name}» в ${accountCurrency}, сумма в ${amountCurrency}.`,
  importCounts: (counts: { readonly new: number; readonly duplicate: number; readonly skipped: number }) =>
    `Новых ${counts.new}, уже есть ${counts.duplicate}, пропущено ${counts.skipped}.`,
  importDone: (count: number) => `Записано ${count}.`,
  mappingNeeded: (headers: readonly string[]) =>
    `Файл не знаком. Колонки: ${headers.join(", ")}. Напишите профиль: имя | date=колонка | amount=колонка | description=колонка | currency=RSD`,
  planSaved: (amount: string, currency: string, name: string, day: number, monthLabel: string) =>
    `${amount} ${currency} · ${name} · день ${day} · ${monthLabel}`,
  closePlan: (name: string) => `Закрыть «${name}»`,
} as const;

export const buttons = {
  undo: "Отменить",
  yes: "Да",
  no: "Не надо",
  timeZone: "Europe/Belgrade",
  commit: "Записать",
} as const;

const MONTHS = [
  "январь",
  "февраль",
  "март",
  "апрель",
  "май",
  "июнь",
  "июль",
  "август",
  "сентябрь",
  "октябрь",
  "ноябрь",
  "декабрь",
] as const;

export function monthLabel(year: number, month: number): string {
  const name = MONTHS[month - 1] ?? String(month);
  return `${name} ${year}`;
}
