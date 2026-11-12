import { DEFAULT_TIME_ZONE } from "@mon22r/domain";

import { STARTER_ACCOUNTS } from "./onboarding.js";

/**
 * Everything the bot says. Chat messages are sent with Telegram's HTML parse mode: the strings in `text` are HTML,
 * and every function there escapes the values it is given unless the parameter is named `html`.
 * `toast` and `buttons` are plain text: Telegram does not format callback answers or button labels.
 * The voice is calm and short: no exclamation marks, no emoji; emphasis is bold for the amount or the title,
 * and `<code>` for anything meant to be copied.
 */

/** Escapes a value for Telegram's HTML parse mode. */
export function esc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const STARTERS = STARTER_ACCOUNTS.map((account) => `${account.name} · ${account.currency}`).join(", ");
const PROFILE_LINE = "<code>профиль имя | date=колонка | amount=колонка | description=колонка | currency=RSD</code>";

function step(index: number, title: string, body: string): string {
  return `Шаг ${index} из 3\n<b>${title}</b>\n${body}`;
}

const askCurrency = step(
  1,
  "Домашняя валюта",
  "В ней считается итог месяца. Выберите или напишите код, например <code>USD</code>.",
);

const help = [
  "<b>Как записывать</b>",
  "Одна строка — одна запись: что и сколько.",
  "",
  "<b>Расход</b>",
  "<code>кофе 350</code>",
  "<code>кофе 350 #еда</code> — с категорией",
  "<code>кофе 4.50 gbp</code> — в другой валюте",
  "",
  "<b>Доход и возврат</b>",
  "<code>+зп 180000</code>",
  "<code>возврат кроссовки 5000</code>",
  "",
  "<b>Другой день</b>",
  "<code>вчера такси 1200</code>",
  "<code>5.11 такси 1200</code>",
  "",
  "<b>Перевод между счетами</b>",
  "<code>перевод 5000 на наличные</code>",
  "<code>перевод 500 eur с евро на карта 58600</code> — с обменом: сколько ушло и сколько пришло",
  "",
  "<b>Ожидаемый доход</b>",
  "<code>план зп 180000 5</code> — каждый месяц 5-го числа",
  "",
  "Сумма без валюты идёт на основной счёт, он выбирается в приложении.",
  "Выписку из банка можно прислать файлом CSV.",
  "",
  "/month — итоги месяца",
  "/undo — отменить последнюю запись",
].join("\n");

export const text = {
  start: `<b>mon22r</b> — учёт расходов и доходов в этом чате.\nСначала три коротких вопроса.\n\n${askCurrency}`,
  askCurrency,
  invalidCurrency: "Нужен код валюты из трёх букв, например <code>RSD</code> или <code>USD</code>.",
  askTimeZone: step(
    2,
    "Часовой пояс",
    `По нему делятся дни и месяцы. Оставьте ${DEFAULT_TIME_ZONE} или напишите свой, например <code>Europe/Moscow</code>.`,
  ),
  invalidTimeZone: `Не знаю такой часовой пояс. Напишите в виде <code>Europe/Moscow</code> или оставьте ${DEFAULT_TIME_ZONE}.`,
  askAccounts: step(
    3,
    "Счета",
    `Создать стартовые счета: ${esc(STARTERS)}? Названия можно изменить позже, в приложении.`,
  ),
  needYesOrNo: "Ответьте «да», чтобы создать эти счета, или «нет».",
  accountsCreated: "<b>Готово.</b> Счета созданы, можно записывать.",
  accountsSkipped: "<b>Готово.</b> Счета добавляются в приложении, в настройках.",
  help,
  unparsed: "Не понял запись. Напишите, например, <code>кофе 350</code>. Все примеры — /help",
  failed: "Сбой, запись не сохранена. Отправьте её ещё раз.",
  doneUnconfirmed: "Сохранено, но подтверждение не отправилось. Проверьте через /month.",
  replayed: "Это сообщение уже обработано.",
  nothingToUndo: "Отменять нечего.",
  alreadyUndone: "Уже отменено.",
  denied: "Нет доступа.",
  editIgnored: "Правки сообщений не учитываются. Отмените запись и отправьте новую.",
  unsupported: "Понимаю текст вроде <code>кофе 350</code> и выписки в CSV. Все примеры — /help",
  setupFirst: "Сначала закончим настройку: /start",
  sameAccount: "Это тот же счёт. Укажите другой.",
  monthEmpty: "В этом месяце записей нет.",

  needCsv: "Читаю только выписки в формате CSV.",
  fileTooBig: "Файл слишком большой.",
  fileUnreadable: "Не смог прочитать файл.",
  fileFirst: "Сначала пришлите файл выписки.",
  columnsMissing: "В файле нет такой колонки. Проверьте названия.",
  profileSaved: "Профиль сохранён. Пришлите файл ещё раз.",
  profileBad: `Нужна строка такого вида:\n${PROFILE_LINE}`,
  importEmpty: "В файле нет строк.",
  mixedCurrency: "В файле несколько валют. Пришлите выписку по одному счёту.",
  accountChoice: "На какой счёт записать?",
  nothingNew: "Новых строк нет, записывать нечего.",
  importCancelled: "Выписка не записана.",
  importGone: "Эта выписка уже записана или отменена.",

  /** Plain: sent by the backup job without a parse mode. */
  backupFailed: "Резервная копия не удалась. Подробности в журнале сервера.",
  backupCaption: (transactions: number) => `Резервная копия, операций: ${transactions}.`,

  currencyChosen: (currency: string) => `Домашняя валюта — <b>${esc(currency)}</b>`,
  timeZoneChosen: (timeZone: string) => `Часовой пояс — <b>${esc(timeZone)}</b>`,
  accountsChosen: (created: boolean) => `Стартовые счета — <b>${created ? "созданы" : "не нужны"}</b>`,
  /** `html` is an entry line that is already escaped. */
  undone: (html: string) => `Запись отменена\n<s>${html}</s>`,
  newCategory: (name: string) => `Новая категория «${esc(name)}».`,
  noAccount: (currency: string) => `Нет счёта в ${esc(currency)}. Добавьте его в приложении, в настройках.`,
  noDestination: (name: string) => `Нет счёта «${esc(name)}».`,
  ambiguousAccount: (name: string, candidates: readonly string[]) =>
    `«${esc(name)}» подходит к нескольким счетам: ${esc(candidates.join(", "))}. Напишите название точнее.`,
  arrivalRequired: (from: string, to: string, currency: string) =>
    `«${esc(from)}» и «${esc(to)}» в разных валютах. Добавьте в конце, сколько пришло в ${esc(currency)}:\n<code>перевод 500 eur на ${esc(to.toLowerCase())} 58600</code>`,
  currencyMismatch: (name: string, accountCurrency: string, amountCurrency: string) =>
    `Счёт «${esc(name)}» в ${esc(accountCurrency)}, а сумма в ${esc(amountCurrency)}.`,
  importCounts: (counts: { readonly new: number; readonly duplicate: number; readonly skipped: number }) =>
    `Новых ${counts.new} · уже есть ${counts.duplicate} · пропущено ${counts.skipped}`,
  /** The preview of a statement that has an account: what it is, where it goes, and what is in it. */
  importPreview: (
    counts: { readonly new: number; readonly duplicate: number; readonly skipped: number },
    accountName: string,
  ) => `<b>Выписка</b> · ${esc(accountName)}\n${text.importCounts(counts)}`,
  importDone: (count: number, accountName: string) =>
    `<b>Выписка записана</b> · ${esc(accountName)}\nНовых записей: ${count}. Категории можно расставить в приложении.`,
  mappingNeeded: (headers: readonly string[]) =>
    `<b>Незнакомый формат выписки</b>\nКолонки: ${esc(headers.join(", "))}\n\nОпишите его один раз, одной строкой:\n${PROFILE_LINE}`,
  /** `when` says the day and how often, for example `каждый месяц 5-го числа · с ноября 2026`. */
  planSaved: (amount: string, currency: string, name: string, when: string) =>
    `<b>План «${esc(name)}»</b> сохранён\n${esc(amount)} ${esc(currency)} · ${esc(when)}`,
} as const;

/** Short answers to a button press. Plain text. */
export const toast = {
  failedAction: "Сбой. Проверьте запись в приложении.",
  alreadyUndone: "Уже отменено.",
  denied: "Нет доступа.",
  closed: "Засчитано в план.",
  alreadyClosed: "Уже засчитано.",
  importGone: "Эта выписка уже записана или отменена.",
  movedTo: (name: string) => `Перенесено: ${name}`,
} as const;

/** Button labels. Plain text. */
export const buttons = {
  undo: "Отменить",
  createAccounts: "Создать счета",
  skipAccounts: "Не надо",
  keepTimeZone: `Оставить ${DEFAULT_TIME_ZONE}`,
  commit: "Записать",
  cancel: "Не записывать",
  app: "Открыть mon22r",
} as const;

/** The button that counts an income toward an expected one. */
export function closePlanLabel(name: string): string {
  return `Засчитать в план «${name}»`;
}

/** Currencies offered as buttons in setup; any other ISO code can be typed. */
export const CURRENCY_CHOICES = ["EUR", "RSD", "RUB", "GBP"] as const;

export const commands = [
  { command: "month", description: "Итоги месяца" },
  { command: "undo", description: "Отменить последнюю запись" },
  { command: "help", description: "Как записывать" },
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

/** `2026, 11` -> `с ноября 2026`. */
export function sinceMonthLabel(year: number, month: number): string {
  const name = MONTHS_GENITIVE[month - 1] ?? String(month);
  return `с ${name} ${year}`;
}

/** `2026-11-11` -> `11 ноября`. */
export function dayLabel(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  const month = match?.[2] === undefined ? undefined : MONTHS_GENITIVE[Number(match[2]) - 1];
  if (match?.[3] === undefined || month === undefined) return isoDate;
  return `${Number(match[3])} ${month}`;
}
