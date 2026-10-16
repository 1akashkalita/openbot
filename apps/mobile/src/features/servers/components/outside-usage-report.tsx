import { agentProviderCliName, isAgentProvider, type OutsideUsageReport } from "@openbot/contracts/ipc";
import { Typography } from "heroui-native";
import { View } from "react-native";
import { SettingsRow, SettingsSection } from "@/features/settings/components/settings-content";
import { useText } from "@/shared/lib/text";

const providerName = (value: string) => (isAgentProvider(value) ? agentProviderCliName(value) : value);

/**
 * The usage that the provider CLIs on the host logged for sessions OpenBot did not run. It is its own section:
 * none of it is in the server totals above it.
 */
export function OutsideUsageSection({ report }: { report: OutsideUsageReport }) {
  const { t, format } = useText();
  const number = (value: number | null) =>
    value === null ? t("mobile.agent.runtime.unavailable") : format.number(value);
  const money = (value: number | null) =>
    value === null
      ? t("mobile.agent.runtime.unavailable")
      : format.currencyUsd(value, { minimumFractionDigits: 4, maximumFractionDigits: 4, useGrouping: false });
  const totals = report.totals;
  const sources = report.sources
    .filter((source) => source.files > 0)
    .map((source) =>
      t("mobile.server.usage.outside.source", {
        count: source.files,
        provider: providerName(source.provider),
        files: format.number(source.files),
      }),
    );
  const footer = [
    ...sources,
    report.scannedAt
      ? t("mobile.server.usage.outside.scannedAt", {
          time: format.date(new Date(report.scannedAt), {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "numeric",
          }),
        })
      : t("mobile.server.usage.outside.notScanned"),
  ].join(" · ");
  return (
    <View className="gap-2">
      <SettingsSection title={t("mobile.server.usage.outside.title")}>
        {totals.turns > 0 ? (
          <>
            {(
              [
                ["mobile.agent.usage.processedTokens", number(totals.processedTokens)],
                ["mobile.agent.usage.estimatedCost", money(totals.estimatedCostUsd)],
                ["mobile.server.usage.outside.requests", number(totals.turns)],
                ["mobile.server.usage.outside.sessions", number(totals.sessions)],
              ] as const
            ).map(([label, value]) => (
              <SettingsRow key={label} trailing={<Typography>{value}</Typography>}>
                <Typography>{t(label)}</Typography>
              </SettingsRow>
            ))}
            {report.models.map((model) => (
              <SettingsRow
                key={`${model.provider}:${model.model}`}
                supportingText={t("mobile.agent.usage.modelLine", {
                  provider: providerName(model.provider),
                  tokens: number(model.processedTokens),
                  cost: money(model.estimatedCostUsd),
                })}
              >
                <Typography numberOfLines={1}>{model.model || t("mobile.agent.usage.unknownModel")}</Typography>
              </SettingsRow>
            ))}
          </>
        ) : (
          <SettingsRow>
            <Typography.Paragraph className="text-grouped-secondary">
              {t("mobile.server.usage.outside.empty")}
            </Typography.Paragraph>
          </SettingsRow>
        )}
      </SettingsSection>
      <View className="gap-2 px-1">
        <Typography type="body-xs" className="text-grouped-secondary">
          {t("mobile.server.usage.outside.description")}
        </Typography>
        {totals.unpricedRecords > 0 || totals.incompleteRecords > 0 ? (
          <Typography type="body-xs" className="text-grouped-secondary">
            {t("mobile.server.usage.outside.partial", {
              unpriced: totals.unpricedRecords,
              incomplete: totals.incompleteRecords,
            })}
          </Typography>
        ) : null}
        <Typography type="body-xs" className="text-grouped-secondary">
          {footer}
        </Typography>
      </View>
    </View>
  );
}
