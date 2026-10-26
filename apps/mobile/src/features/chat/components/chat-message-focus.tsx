import { type ConversationReaction, MESSAGE_REACTIONS, MORE_MESSAGE_REACTIONS } from "@openbot/contracts/ipc";
import { markdownPlainText } from "@openbot/contracts/markdown-preview-text";
import { SELECTION_ACTION_INSTRUCTIONS, type SelectionAction } from "@openbot/contracts/selection-instruction";
import type { MobileTextKey } from "@openbot/i18n/mobile";
import { BlurView } from "expo-blur";
import * as Clipboard from "expo-clipboard";
import { GlassView } from "expo-glass-effect";
import { Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import type { LucideIcon } from "lucide-react-native";
import Copy from "lucide-react-native/icons/copy";
import PencilLine from "lucide-react-native/icons/pencil-line";
import Plus from "lucide-react-native/icons/plus";
import Reply from "lucide-react-native/icons/reply";
import TextSelect from "lucide-react-native/icons/square-dashed-text";
import { memo, type PropsWithChildren, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  type ColorValue,
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type ViewInstance,
  type ViewStyle,
} from "react-native";
import Animated, {
  type CSSTransitionProperties,
  cubicBezier,
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { showFailureAlert } from "@/features/analytics/failure-reports";
import type { MobileAgent } from "@/features/workspace/context/mobile-workspace-context";
import { haptics } from "@/shared/lib/haptics";
import { useReducedMotion } from "@/shared/lib/motion";
import { isIOS } from "@/shared/lib/platform";
import { useText } from "@/shared/lib/text";
import type { ChatBubbleMessage } from "../model/chat-messages";
import { nativeTextSelection } from "../model/native-text-selection";
import { ChatMarkdown } from "./chat-markdown";
import { ChatSelectableText } from "./chat-selectable-text";

/**
 * The message that a touch and hold lifts out of the chat, as the list measured and drew it.
 */
export interface MessageFocusTarget {
  message: ChatBubbleMessage;
  /** The text bubble in window coordinates. */
  frame: { x: number; y: number; width: number; height: number };
  align: "start" | "end";
  /** A plain colour for a bubble whose list colour is animated or a member's colour. Unset uses the agent bubble. */
  bubbleColor: string | undefined;
  textColor: ColorValue | undefined;
  /** The text that Copy puts on the clipboard. */
  copyText: string;
}

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const ENTER = { duration: 260, easing: EASE_OUT, reduceMotion: ReduceMotion.System };
const EXIT = { duration: 200, easing: EASE_OUT, reduceMotion: ReduceMotion.System };
/** Seconds, for the native glass animation. */
const GLASS_IN = 0.26;
const GLASS_OUT = 0.2;
const FADE: CSSTransitionProperties = {
  transitionProperty: "opacity",
  transitionDuration: 200,
  transitionTimingFunction: cubicBezier(0.23, 1, 0.32, 1),
};
// As the voice mode: one even blur, and a veil in the canvas colour over it. Without the blur the
// veil does the work alone.
const CHAT_BLUR = 14;
const VEIL = { blurred: 0.45, plain: 0.82 } as const;
const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);
/** The room from the safe area to the lifted message and its menus. */
const EDGE = 8;
const GAP = 8;
const SIDE = 16;
const EMOJI_SIZE = 44;
const BAR_PADDING = 4;
const REACTION_BAR = EMOJI_SIZE + BAR_PADDING * 2;
const ROW = 48;
const MENU_PADDING = 6;
const MENU_RADIUS = 26;
const DIVIDER = 1 + MENU_PADDING * 2;
const MENU_WIDTH = 268;
const ICON_SIZE = 20;
const CHIP = 36;
/** The widest part of the list that a message bubble takes, as `max-w-[88%]` on its row. */
const BUBBLE_MAX_WIDTH = 0.88;
const CHIP_GAP = 6;
const CHIP_GAP_MAX = 20;
/** The least part of a chip that shows at the edge of the row, so the row reads as one that scrolls. */
const CHIP_PEEK = 24;
/** A selection adds a row of its actions, Copy selection and Describe edits, and a line. */
const SELECTION_SPACE = CHIP + MENU_PADDING * 2 + ROW * 2 + DIVIDER;

/** The actions for selected text, as on desktop. Each one sends at once as a reply to the message. */
const SELECTION_ACTIONS: readonly { action: SelectionAction; label: MobileTextKey }[] = [
  { action: "Explain", label: "mobile.chat.selection.explain" },
  { action: "Improve", label: "mobile.chat.selection.improve" },
  { action: "Shorten", label: "mobile.chat.selection.shorten" },
  { action: "Tone", label: "mobile.chat.selection.tone" },
  { action: "Grammar", label: "mobile.chat.selection.grammar" },
];

/**
 * The gap between the chips of the selection actions. When they do not all fit, the edge of the menu
 * must cut a chip, with a part of it on each side: a gap that falls on the edge would hide that the
 * row scrolls. The widths change with the language, so the gap is found from the measured chips.
 */
function peekingGap(widths: readonly number[], viewport: number) {
  if (!viewport || widths.some((width) => !width)) return CHIP_GAP;
  for (let gap = CHIP_GAP; gap <= CHIP_GAP_MAX; gap += 1) {
    let left = MENU_PADDING;
    let peeks = true;
    for (const [index, width] of widths.entries()) {
      const right = left + width;
      if (right > viewport) {
        peeks = viewport - left >= CHIP_PEEK && right - viewport >= CHIP_PEEK;
        break;
      }
      left = right + gap;
      // The next chip starts at or past the edge: the row would seem to end at a whole chip.
      if (index < widths.length - 1 && left >= viewport - CHIP_PEEK) {
        peeks = false;
        break;
      }
    }
    if (peeks) return gap;
  }
  return CHIP_GAP;
}

interface MenuItem {
  key: string;
  label: string;
  icon: LucideIcon;
  onPress: () => void;
}

const ChatBlur = memo(function ChatBlur({ presence }: { presence: SharedValue<number> }) {
  const props = useAnimatedProps(() => ({ intensity: CHAT_BLUR * presence.get() }));
  return (
    <AnimatedBlurView
      pointerEvents="none"
      tint="systemUltraThinMaterial"
      animatedProps={props}
      style={StyleSheet.absoluteFill}
    />
  );
});

/**
 * Liquid Glass where iOS has it, the solid surface of the chat controls elsewhere. Glass draws
 * nothing under an ancestor with an opacity below 1, so the glass turns on and off with its own
 * native animation and only the content and the solid stand-in fade.
 */
function GlassSurface({
  children,
  lit,
  liquidGlassAvailable,
  fallbackBackground,
  radius,
  style,
  onLayout,
}: PropsWithChildren<{
  lit: boolean;
  liquidGlassAvailable: boolean;
  fallbackBackground: ViewStyle["backgroundColor"];
  radius: number;
  style: ViewStyle;
  onLayout?: (event: LayoutChangeEvent) => void;
}>) {
  const reducedMotion = useReducedMotion();
  return (
    <GlassView
      glassEffectStyle={{
        style: liquidGlassAvailable && lit ? "regular" : "none",
        animate: true,
        animationDuration: reducedMotion ? 0 : lit ? GLASS_IN : GLASS_OUT,
      }}
      isInteractive={liquidGlassAvailable && lit}
      onLayout={onLayout}
      style={[
        { backgroundColor: "transparent", borderRadius: radius, borderCurve: "continuous", overflow: "hidden" },
        style,
      ]}
    >
      {liquidGlassAvailable ? null : (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: fallbackBackground,
            opacity: lit ? 1 : 0,
            ...FADE,
          }}
        />
      )}
      <Animated.View style={{ opacity: lit ? 1 : 0, ...FADE }}>{children}</Animated.View>
    </GlassView>
  );
}

function MenuRow({ item, foreground }: { item: MenuItem; foreground: string }) {
  const Icon = item.icon;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={item.label}
      onPress={item.onPress}
      className="flex-row items-center gap-3 rounded-2xl px-3 active:bg-default-hover/30"
      style={{ height: ROW }}
    >
      <Icon size={ICON_SIZE} color={foreground} strokeWidth={1.9} />
      <Typography.Paragraph numberOfLines={1} className="flex-1">
        {item.label}
      </Typography.Paragraph>
    </Pressable>
  );
}

/**
 * The chat after a touch and hold on a message: the chat steps back, the message rises a little, the
 * reactions stand above it and the actions under it, on Liquid Glass where iOS has it. The lifted
 * text can be selected; a selection adds every action of the selection bar, Copy selection and
 * Describe edits. Native text views select with a touch and hold. Without them, as on Android and in
 * Expo Go, Select text puts the read-only text field of the chat over the message, with all text
 * selected.
 *
 * The chat mounts one of these while a message is lifted, so the rows of the list carry no part of
 * it but the hold.
 */
export function ChatMessageFocus({
  target,
  reactions,
  agents,
  canSend,
  reducedTransparency,
  liquidGlassAvailable,
  fallbackBackground,
  onReact,
  onReply,
  onSelectionAction,
  onDescribeEdits,
  onLifted,
  onClosed,
}: {
  target: MessageFocusTarget;
  /** The latest reactions of the message: the list may update them while it is lifted. */
  reactions: readonly ConversationReaction[] | undefined;
  agents: readonly MobileAgent[];
  canSend: boolean;
  reducedTransparency: boolean;
  liquidGlassAvailable: boolean;
  fallbackBackground: ViewStyle["backgroundColor"];
  /** Unset where a reaction cannot be saved. `null` removes the reader's reaction. */
  onReact?: (message: ChatBubbleMessage, emoji: string | null) => Promise<void>;
  onReply?: (message: ChatBubbleMessage) => void;
  onSelectionAction: (message: ChatBubbleMessage, quote: string, instruction: string) => void;
  /** The composer takes the selected text, and the reader writes how to change it. */
  onDescribeEdits: (message: ChatBubbleMessage, quote: string) => void;
  /** The lifted copy covers the message, so the list can hide its own bubble. */
  onLifted: () => void;
  /** Called once the lift has gone, so the chat can unmount it. */
  onClosed: () => void;
}) {
  const { t } = useText();
  const insets = useSafeAreaInsets();
  const [foregroundColor, mutedColor] = useThemeColor(["foreground", "muted"]);
  const foreground = String(foregroundColor);
  const muted = String(mutedColor);
  const { message, frame, align } = target;
  const presence = useSharedValue(0);
  const closing = useRef(false);
  // Off while the lift leaves, so a second tap does not run an action again.
  const [leaving, setLeaving] = useState(false);
  const root = useRef<ViewInstance>(null);
  const [area, setArea] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [layout, setLayout] = useState<{ top: number; bubbleTop: number; bubbleMaxHeight: number } | null>(null);
  const [selected, setSelected] = useState("");
  // Without native text views, Select text puts the read-only field of the chat over the text.
  const [selecting, setSelecting] = useState(false);
  const [selectionHeight, setSelectionHeight] = useState(0);
  const [moreEmoji, setMoreEmoji] = useState(false);
  const [chipViewport, setChipViewport] = useState(0);
  // One width for each chip, 0 until it has a layout.
  const [chipWidths, setChipWidths] = useState<readonly number[]>(() => SELECTION_ACTIONS.map(() => 0));
  const chipGap = useMemo(() => peekingGap(chipWidths, chipViewport), [chipWidths, chipViewport]);
  const quote = selected.trim();
  const own = reactions?.find((reaction) => reaction.actor.kind === "user")?.emoji ?? null;
  const blurred = isIOS && !reducedTransparency;
  const veil = blurred ? VEIL.blurred : VEIL.plain;
  const lit = Boolean(layout) && !leaving;

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setLeaving(true);
    presence.set(
      withTiming(0, EXIT, (finished) => {
        if (finished) scheduleOnRN(onClosed);
      }),
    );
  }, [onClosed, presence]);

  useEffect(() => {
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => back.remove();
  }, [close]);

  // The list measured the bubble in window coordinates. The layer may not start at the window's
  // corner, so it measures itself in the same coordinates.
  const measureArea = () => {
    root.current?.measureInWindow((x, y, width, height) => {
      if (height > 0) setArea({ x, y, width, height });
    });
  };

  const lifted = useRef(onLifted);
  lifted.current = onLifted;
  useEffect(() => {
    // A close before the first layout keeps its exit: the entrance would interrupt it.
    if (!layout || closing.current) return;
    lifted.current();
    presence.set(withTiming(1, ENTER));
  }, [layout, presence]);

  // Native text views report the selection of the lifted text. One object, so the text does not
  // draw again on each render.
  const nativeSelection = useMemo(
    () => (nativeTextSelection ? { generation: 0, onSelect: setSelected } : undefined),
    [],
  );

  const run = (action: () => void) => () => {
    close();
    action();
  };

  const copy = async (text: string) => {
    try {
      await Clipboard.setStringAsync(text);
      void haptics.notification("success");
    } catch (error) {
      void haptics.notification("error");
      showFailureAlert(error, "turn", t("mobile.chat.message.copyFailed"), t("mobile.chat.copyFailedMessage"));
    }
  };

  const react = (emoji: string | null) => {
    if (!onReact) return;
    void haptics.selection();
    close();
    onReact(message, emoji).catch((error: unknown) => {
      void haptics.notification("error");
      showFailureAlert(error, "turn", t("mobile.chat.message.reactionFailed"), t("mobile.chat.copyFailedMessage"));
    });
  };

  const selectionItems: MenuItem[] = [
    {
      key: "copy-selection",
      label: t("mobile.chat.focus.copySelection"),
      icon: Copy,
      onPress: run(() => void copy(quote)),
    },
    ...(canSend
      ? [
          {
            key: "describe",
            label: t("mobile.chat.selection.describe"),
            icon: PencilLine,
            onPress: run(() => onDescribeEdits(message, quote)),
          },
        ]
      : []),
  ];
  const messageItems: MenuItem[] = [
    ...(onReply
      ? [{ key: "reply", label: t("mobile.chat.message.reply"), icon: Reply, onPress: run(() => onReply(message)) }]
      : []),
    ...(target.copyText
      ? [
          {
            key: "copy",
            label: t("mobile.chat.message.copy"),
            icon: Copy,
            onPress: run(() => void copy(target.copyText)),
          },
        ]
      : []),
    ...(!nativeTextSelection && !selecting
      ? [
          {
            key: "select",
            label: t("mobile.chat.message.selectText"),
            icon: TextSelect,
            onPress: () => {
              void haptics.selection();
              setSelecting(true);
            },
          },
        ]
      : []),
  ];

  // The place of the lifted message is set once, from the first layout of the menu, so the message
  // does not move while the reader selects in it. The menu keeps room for the rows of a selection.
  const onMenuLayout = ({ nativeEvent }: LayoutChangeEvent) => {
    if (layout || !area) return;
    const top0 = Math.max(0, insets.top - area.y) + EDGE;
    const bottom0 = area.height - insets.bottom - EDGE;
    const barSpace = onReact ? REACTION_BAR + GAP : 0;
    const menuSpace = GAP + nativeEvent.layout.height + (quote ? 0 : SELECTION_SPACE);
    const bubbleHeight = Math.min(frame.height, Math.max(ROW, bottom0 - top0 - barSpace - menuSpace));
    const bubbleTop = frame.y - area.y;
    const top = Math.max(top0, Math.min(bubbleTop - barSpace, bottom0 - barSpace - bubbleHeight - menuSpace));
    setLayout({ top, bubbleTop, bubbleMaxHeight: Math.max(ROW, bottom0 - top - barSpace - menuSpace) });
  };

  const veilStyle = useAnimatedStyle(() => ({ opacity: presence.get() * veil }));
  // The copy starts where the message is in the list and moves to its lifted place, and goes back
  // when the lift leaves, so the list bubble shows again under it with no jump.
  const barSpace = onReact ? REACTION_BAR + GAP : 0;
  const travel = layout ? layout.bubbleTop - (layout.top + barSpace) : 0;
  const bubbleStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: travel * (1 - presence.get()) }, { scale: 1 + 0.02 * presence.get() }],
  }));
  const edge = align === "end" ? "flex-end" : "flex-start";
  // The copy keeps the side of the message and may grow to the widest bubble of the list: its text
  // view may measure a line a little wider than the list text, and must not wrap it then.
  const bubbleInset = area
    ? align === "end"
      ? { marginRight: area.x + area.width - SIDE - (frame.x + frame.width) }
      : { marginLeft: frame.x - area.x - SIDE }
    : {};
  const bubbleMaxWidth = area ? Math.max(frame.width, (area.width - SIDE * 2) * BUBBLE_MAX_WIDTH) : frame.width;

  return (
    <View
      ref={root}
      onLayout={measureArea}
      pointerEvents={leaving ? "none" : "auto"}
      style={[StyleSheet.absoluteFill, { zIndex: 40 }]}
      accessibilityViewIsModal
      accessibilityLabel={t("mobile.chat.message.actions")}
      onAccessibilityEscape={close}
    >
      {blurred ? <ChatBlur presence={presence} /> : null}
      <Animated.View pointerEvents="none" className="absolute inset-0 bg-background" style={veilStyle} />
      <Pressable style={StyleSheet.absoluteFill} accessible={false} onPress={close} />
      {area ? (
        // No opacity here or above: it would turn off the glass of the menus.
        <View
          pointerEvents="box-none"
          style={{ position: "absolute", left: SIDE, right: SIDE, top: layout?.top ?? 0, gap: GAP }}
        >
          {onReact ? (
            <GlassSurface
              lit={lit}
              liquidGlassAvailable={liquidGlassAvailable}
              fallbackBackground={fallbackBackground}
              radius={REACTION_BAR / 2}
              style={{ alignSelf: edge, maxWidth: "100%", height: REACTION_BAR }}
            >
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                style={{ flexGrow: 0 }}
                contentContainerStyle={{ padding: BAR_PADDING, alignItems: "center" }}
                accessibilityLabel={t("mobile.chat.message.addReaction")}
              >
                {[...MESSAGE_REACTIONS, ...(moreEmoji ? MORE_MESSAGE_REACTIONS : [])].map((emoji) => (
                  <Pressable
                    key={emoji}
                    accessibilityRole="button"
                    accessibilityLabel={t("mobile.chat.message.react", { emoji })}
                    accessibilityState={{ selected: emoji === own }}
                    onPress={() => react(emoji === own ? null : emoji)}
                    className={`items-center justify-center rounded-full active:bg-default-hover/30 ${emoji === own ? "bg-default" : ""}`}
                    style={{ width: EMOJI_SIZE, height: EMOJI_SIZE }}
                  >
                    <Typography className="text-xl">{emoji}</Typography>
                  </Pressable>
                ))}
                {moreEmoji ? null : (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("mobile.chat.message.moreEmoji")}
                    onPress={() => {
                      void haptics.selection();
                      setMoreEmoji(true);
                    }}
                    className="items-center justify-center rounded-full active:bg-default-hover/30"
                    style={{ width: EMOJI_SIZE, height: EMOJI_SIZE }}
                  >
                    <Plus size={ICON_SIZE} color={muted} />
                  </Pressable>
                )}
              </ScrollView>
            </GlassSurface>
          ) : null}
          <Animated.View
            style={[
              { ...bubbleInset, alignSelf: edge, maxWidth: bubbleMaxWidth, opacity: layout ? 1 : 0 },
              { transformOrigin: align === "end" ? "100% 50%" : "0% 50%" },
              bubbleStyle,
            ]}
          >
            <ScrollView
              style={{ maxHeight: layout?.bubbleMaxHeight }}
              showsVerticalScrollIndicator={false}
              alwaysBounceVertical={false}
              overScrollMode="never"
            >
              {/* The bubble colours are see-through over the chat. The copy lies over the dimmed chat, so
                  it gets the chat background under its colour and looks as it does in the list. */}
              <View className="rounded-[30px] bg-background" style={{ borderCurve: "circular", overflow: "hidden" }}>
                <View
                  className={`rounded-[30px] px-4 py-3 ${target.bubbleColor ? "" : "bg-control/60"}`}
                  style={[
                    { borderCurve: "circular", overflow: "hidden" },
                    target.bubbleColor ? { backgroundColor: target.bubbleColor } : undefined,
                  ]}
                >
                  <View style={selecting ? { minHeight: selectionHeight } : undefined}>
                    <View
                      style={selecting ? { opacity: 0 } : undefined}
                      accessibilityElementsHidden={selecting}
                      importantForAccessibility={selecting ? "no-hide-descendants" : "auto"}
                    >
                      <ChatMarkdown
                        agents={agents}
                        body={message.body}
                        finished
                        selectable={false}
                        animationEnabled={false}
                        color={target.textColor}
                        nativeSelection={nativeSelection}
                      />
                    </View>
                    {selecting ? (
                      <ChatSelectableText
                        text={markdownPlainText(message.body)}
                        color={target.textColor}
                        onHeight={setSelectionHeight}
                        onSelectionChange={setSelected}
                        // The menu under the message has Copy selection and the other actions.
                        systemMenu={false}
                      />
                    ) : null}
                  </View>
                </View>
              </View>
            </ScrollView>
          </Animated.View>
          <GlassSurface
            lit={lit}
            liquidGlassAvailable={liquidGlassAvailable}
            fallbackBackground={fallbackBackground}
            radius={MENU_RADIUS}
            onLayout={onMenuLayout}
            style={{ alignSelf: edge, width: MENU_WIDTH, maxWidth: "100%" }}
          >
            <View style={{ padding: MENU_PADDING }}>
              {quote ? (
                <View accessibilityLabel={t("mobile.chat.selection.label")}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    keyboardShouldPersistTaps="handled"
                    onLayout={({ nativeEvent }) => setChipViewport(nativeEvent.layout.width)}
                    // To the edges of the menu, so a chip that does not fit is cut by the glass edge.
                    style={{ marginHorizontal: -MENU_PADDING }}
                    contentContainerStyle={{ gap: chipGap, padding: MENU_PADDING }}
                  >
                    {SELECTION_ACTIONS.map(({ action, label }, index) => (
                      <Pressable
                        key={action}
                        onLayout={({ nativeEvent }) => {
                          const width = nativeEvent.layout.width;
                          setChipWidths((current) => {
                            if (current[index] === width) return current;
                            const next = [...current];
                            next[index] = width;
                            return next;
                          });
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={t(label)}
                        accessibilityState={{ disabled: !canSend }}
                        disabled={!canSend}
                        onPress={run(() => onSelectionAction(message, quote, SELECTION_ACTION_INSTRUCTIONS[action]))}
                        className="flex-row items-center rounded-full bg-control/60 px-3.5 active:bg-default-hover/30"
                        style={{ height: CHIP, opacity: canSend ? 1 : 0.45 }}
                      >
                        <Typography.Paragraph type="body-sm" weight="semibold">
                          {t(label)}
                        </Typography.Paragraph>
                      </Pressable>
                    ))}
                  </ScrollView>
                  {selectionItems.map((item) => (
                    <MenuRow key={item.key} item={item} foreground={foreground} />
                  ))}
                  <View className="bg-separator" style={{ height: 1, marginVertical: MENU_PADDING }} />
                </View>
              ) : null}
              {messageItems.map((item) => (
                <MenuRow key={item.key} item={item} foreground={foreground} />
              ))}
              {nativeTextSelection && !quote ? (
                <Typography.Paragraph type="body-xs" className="px-3 pb-1.5 pt-1 text-muted">
                  {t("mobile.chat.focus.selectHint")}
                </Typography.Paragraph>
              ) : null}
            </View>
          </GlassSurface>
        </View>
      ) : null}
    </View>
  );
}
