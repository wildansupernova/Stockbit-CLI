import { load } from "cheerio";

import { CliError } from "./errors.js";

export interface ParsedPeriod {
  key: string;
  label: string;
}

export interface ParsedFinancialValue {
  period: string;
  display: string;
  available: boolean;
  raw: string | null;
  idr: string | null;
  usd: string | null;
  percentage?: string;
}

export interface ParsedFinancialRow {
  id: string;
  kind: "account" | "heading" | "other" | "formula";
  label: string;
  display_label: string;
  local_label?: string;
  hidden: boolean;
  tree?: {
    left: number | null;
    right: number | null;
  };
  values: ParsedFinancialValue[];
}

export interface ParsedFinancialTable {
  id: string;
  kind: "financials" | "key-ratios" | "other";
  unit_label: string | null;
  periods: ParsedPeriod[];
  rows: ParsedFinancialRow[];
}

export interface ParsedFinancialData {
  message: string | null;
  currencies: string[];
  default_currency: string | null;
  selected_currency: string | null;
  total_periods: number | null;
  rounding_values: Array<string | number>;
  tables: ParsedFinancialTable[];
}

export interface FinancialParseResult {
  data: ParsedFinancialData;
  warnings: string[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
}

function stringAttribute(
  attribute: string | undefined,
  unavailable: boolean,
): string | null {
  if (unavailable || attribute === undefined) {
    return null;
  }
  const value = attribute.trim();
  return value && value !== "-" ? value : null;
}

function optionalInteger(value: string | undefined): number | null {
  if (value === undefined || !/^-?\d+$/u.test(value.trim())) {
    return null;
  }
  return Number.parseInt(value, 10);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function roundingValues(value: unknown): Array<string | number> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string | number =>
          typeof item === "string" || typeof item === "number",
      )
    : [];
}

export function parseFinancialHtmlResponse(response: unknown): FinancialParseResult {
  if (!isRecord(response) || !isRecord(response.data)) {
    throw new CliError(
      "HTML_REPORT_NOT_FOUND",
      "The Stockbit response does not contain a financial data object.",
      4,
    );
  }

  const providerData = response.data;
  if (typeof providerData.html_report !== "string" || !providerData.html_report.trim()) {
    throw new CliError(
      "HTML_REPORT_NOT_FOUND",
      "The Stockbit response does not contain data.html_report.",
      4,
    );
  }

  const $ = load(providerData.html_report, undefined, false);
  const warnings: string[] = [];
  const tables: ParsedFinancialTable[] = [];

  $("table").each((tableIndex, tableElement) => {
    const table = $(tableElement);
    const periods: ParsedPeriod[] = [];

    table
      .find("thead tr")
      .first()
      .find("th.periods-list, th[data-label]")
      .each((periodIndex, periodElement) => {
        const period = $(periodElement);
        periods.push({
          key: period.attr("data-label")?.trim() || `period-${periodIndex + 1}`,
          label: cleanText(period.text()),
        });
      });

    if (periods.length === 0) {
      warnings.push(`Skipped table ${tableIndex + 1} because it has no period headers.`);
      return;
    }

    const tableId = table.attr("id")?.trim() || `table-${tableIndex + 1}`;
    const hasRatioCells = table.find("td.row-ratio-val").length > 0;
    const tableKind: ParsedFinancialTable["kind"] = hasRatioCells
      ? "key-ratios"
      : tableIndex === 0
        ? "financials"
        : "other";
    const rows: ParsedFinancialRow[] = [];

    table.find("tbody tr").each((rowIndex, rowElement) => {
      const row = $(rowElement);
      const cells = row.children("td");
      if (cells.length === 0) {
        return;
      }

      const firstCell = cells.first();
      const accountName = firstCell.find(".acc-name").first();
      const chart = firstCell.find("[data-acc-number]").first();
      const displayLabel = cleanText(accountName.length ? accountName.text() : firstCell.text());
      const englishLabel =
        accountName.attr("data-lang-1-full")?.trim() ||
        accountName.attr("data-lang-1")?.trim() ||
        displayLabel;
      const localLabel =
        accountName.attr("data-lang-0-full")?.trim() ||
        accountName.attr("data-lang-0")?.trim();
      const accountNumber = chart.attr("data-acc-number")?.trim();
      const rowClasses = new Set(
        (row.attr("class") ?? "")
          .split(/\s+/u)
          .map((item) => item.trim())
          .filter(Boolean),
      );
      const isFormula =
        chart.attr("data-chart") === "formula" || row.find("td.row-ratio-val").length > 0;
      const rowKind: ParsedFinancialRow["kind"] = isFormula
        ? "formula"
        : rowClasses.has("r_head") || firstCell.hasClass("r_head")
          ? "heading"
          : rowClasses.has("other")
            ? "other"
            : "account";
      const values: ParsedFinancialValue[] = [];

      cells.slice(1).each((valueIndex, valueElement) => {
        const period = periods[valueIndex];
        if (!period) {
          warnings.push(
            `${tableId} row ${rowIndex + 1} has more value cells than period headers.`,
          );
          return;
        }

        const valueCell = $(valueElement);
        const display = cleanText(valueCell.text());
        const unavailable = !display || display === "-" || /^n\/?a$/iu.test(display);
        const parsedValue: ParsedFinancialValue = {
          period: period.key,
          display,
          available: !unavailable,
          raw: stringAttribute(valueCell.attr("data-raw"), unavailable),
          idr: stringAttribute(valueCell.attr("data-value-idr"), unavailable),
          usd: stringAttribute(valueCell.attr("data-value-usd"), unavailable),
        };
        const percentage = valueCell.attr("data-percentage")?.trim();
        if (percentage) {
          parsedValue.percentage = percentage;
        }
        values.push(parsedValue);
      });

      if (values.length < periods.length) {
        warnings.push(
          `${tableId} row ${rowIndex + 1} has ${values.length} values for ${periods.length} periods.`,
        );
      }

      const parsedRow: ParsedFinancialRow = {
        id: accountNumber || `${tableId}-row-${rowIndex + 1}`,
        kind: rowKind,
        label: englishLabel,
        display_label: displayLabel,
        hidden: rowClasses.has("hides"),
        values,
      };
      if (localLabel) {
        parsedRow.local_label = localLabel;
      }
      const left = row.attr("data-left");
      const right = row.attr("data-right");
      if (left !== undefined || right !== undefined) {
        parsedRow.tree = {
          left: optionalInteger(left),
          right: optionalInteger(right),
        };
      }
      rows.push(parsedRow);
    });

    const unitText = cleanText(
      table.find("thead th.info .info, thead th.info").first().text(),
    );
    tables.push({
      id: tableId,
      kind: tableKind,
      unit_label: unitText || null,
      periods,
      rows,
    });
  });

  if (tables.length === 0) {
    throw new CliError(
      "HTML_REPORT_INVALID",
      "The Stockbit HTML report did not contain a table with period headers.",
      4,
    );
  }

  const totalPeriodsValue = $("input.totalPeriods").first().attr("value");
  const selectedCurrency = $("input.selected_currency").first().attr("value")?.trim();

  return {
    data: {
      message: typeof response.message === "string" ? response.message : null,
      currencies: stringArray(providerData.currency),
      default_currency:
        typeof providerData.default_currency === "string"
          ? providerData.default_currency
          : null,
      selected_currency: selectedCurrency || null,
      total_periods: optionalInteger(totalPeriodsValue),
      rounding_values: roundingValues(providerData.rounding_value),
      tables,
    },
    warnings,
  };
}
