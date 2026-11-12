export const text = {
  askCurrency: "Домашняя валюта: RSD, RUB, GBP или другой код ISO.",
  invalidCurrency: "Нужен код из трёх букв: RSD, RUB, GBP или другой ISO.",
  askTimeZone: "Часовой пояс. Можно оставить Europe/Belgrade.",
  invalidTimeZone: "Не вижу такой часовой пояс. Например Europe/Belgrade.",
  askAccounts: "Создать счета Поштанска RSD, Рубли RUB и UK GBP. Имена можно изменить позже.",
  needYesOrNo: "Напишите да, если создать эти счета, или нет.",
  accountsCreated: "Счета созданы.",
  accountsSkipped: "Счета не созданы.",
  unparsed: "Не разобрал. Например: кофе 350. Все примеры: /help",
  failed: "Сбой, ничего не записано. Отправьте ещё раз.",
  failedAction: "Сбой. Проверьте запись в приложении.",
  doneUnconfirmed: "Сделано, но подтверждение не отправилось. Проверьте /month.",
  replayed: "Это сообщение уже обработано.",
  nothingToUndo: "Нечего отменять.",
  alreadyUndone: "Уже отменено.",
  denied: "Нет доступа.",
  help: [
    "кофе 350",
    "кофе 350 #еда",
    "+зп 180000",
    "возврат кроссовки 5000",
    "вчера такси 1200",
    "5.11 такси 1200",
    "перевод 5000 на наличные",
    "перевод 500 eur с евро на карта 58600",
    "план зп 180000 5",
    "",
    "Сумма без валюты идёт на основной счёт. Он выбирается в приложении, в настройках.",
    "/month показывает итоги месяца, /undo снимает последнюю запись.",
    "Выписку можно прислать файлом CSV.",
  ].join("\n"),
  editIgnored: "Правку не учитываю. Отмените запись и отправьте новую.",
  unsupported: "Понимаю текст вроде «кофе 350» и выписки в CSV. Примеры: /help",
  needCsv: "Пока читаю только CSV.",
  fileTooBig: "Файл слишком большой.",
  fileUnreadable: "Не смог прочитать файл.",
  fileFirst: "Сначала пришлите файл.",
  columnsMissing: "В заголовке нет такой колонки.",
  profileSaved: "Профиль сохранён. Пришлите файл ещё раз.",
  profileBad: "Нужна строка: профиль имя | date=колонка | amount=колонка | description=колонка | currency=RSD",
  sameAccount: "Нужен другой счёт.",
  setupFirst: "Сначала домашняя валюта и часовой пояс.",
  importEmpty: "В файле нет строк.",
  mixedCurrency: "В файле несколько валют.",
  accountChoice: "Какой счёт?",
  nothingNew: "Новых строк нет.",
  closed: "Строка закрыта.",
  alreadyClosed: "Строка уже закрыта.",
  monthEmpty: "В этом месяце движений нет.",
  undone: (line: string) => `Отменено: ${line}`,
  newCategory: (name: string) => `Новая категория «${name}».`,
  noAccount: (currency: string) => `Нет счёта в ${currency}. Счёт добавляется в приложении, в настройках.`,
  noDestination: (name: string) => `Нет счёта «${name}».`,
  ambiguousAccount: (name: string, candidates: readonly string[]) =>
    `«${name}» подходит к нескольким счетам: ${candidates.join(", ")}. Напишите название точнее.`,
  arrivalRequired: (from: string, to: string, currency: string) =>
    `«${from}» и «${to}» в разных валютах. Добавьте в конце, сколько пришло в ${currency}: перевод 500 eur на ${to.toLowerCase()} 58600`,
  currencyMismatch: (name: string, accountCurrency: string, amountCurrency: string) =>
    `Счёт «${name}» в ${accountCurrency}, сумма в ${amountCurrency}.`,
  importCounts: (counts: { readonly new: number; readonly duplicate: number; readonly skipped: number }) =>
    `Новых ${counts.new}, уже есть ${counts.duplicate}, пропущено ${counts.skipped}.`,
  importDone: (count: number) => `Записано ${count}.`,
  mappingNeeded: (headers: readonly string[]) =>
    `Файл не знаком. Колонки: ${headers.join(", ")}. Напишите профиль: профиль имя | date=колонка | amount=колонка | description=колонка | currency=RSD`,
  planSaved: (amount: string, currency: string, name: string, day: number, monthLabel: string) =>
    `${amount} ${currency} · ${name} · день ${day} · ${monthLabel}`,
  closePlan: (name: string) => `Закрыть «${name}»`,
  movedTo: (name: string) => `Счёт: ${name}`,
  backupCaption: (transactions: number) => `Резервная копия, операций: ${transactions}.`,
  backupFailed: "Резервная копия не удалась. Подробности в журнале сервера.",
} as const;

export const buttons = {
  undo: "Отменить",
  yes: "Да",
  no: "Не надо",
  timeZone: "Europe/Belgrade",
  commit: "Записать",
  app: "Открыть mon22r",
} as const;

export const commands = [
  { command: "month", description: "Итоги месяца" },
  { command: "undo", description: "Отменить последнюю запись" },
  { command: "help", description: "Как писать" },
] as const;

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

const MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
] as const;

export function monthLabel(year: number, month: number): string {
  const name = MONTHS[month - 1] ?? String(month);
  return `${name} ${year}`;
}

/** `2026-11-11` -> `11 ноября`. */
export function dayLabel(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  const month = match?.[2] === undefined ? undefined : MONTHS_GENITIVE[Number(match[2]) - 1];
  if (match?.[3] === undefined || month === undefined) return isoDate;
  return `${Number(match[3])} ${month}`;
}
