import { type NativeModule, requireOptionalNativeModule } from "expo";
import { useEffect, useRef } from "react";
import { type ColorValue, findNodeHandle, TextInput, type TextInputInstance, useWindowDimensions } from "react-native";
import { isIOS } from "@/shared/lib/platform";
import { useText } from "@/shared/lib/text";

declare class TextSelectionModule extends NativeModule {
  /** Selects all text of the field with the handles and menu of Android. False for an empty field. */
  selectAll(viewTag: number): Promise<boolean>;
}

/**
 * `modules/text-selection`, on Android only. A range that code sets has no handles there, so the
 * module starts the selection mode of a touch and hold. A build without it, such as Expo Go, selects
 * the text without handles.
 */
const textSelection = requireOptionalNativeModule<TextSelectionModule>("OpenBotTextSelection");

/** The body text: 16 points on a 28-point line, as the HeroUI `body` type. */
const FONT_SIZE = 16;
const LINE_HEIGHT = 28;
/** The natural line height of Inter, as a multiple of its size: (1984 + 494) / 2048. */
const FONT_LINE_RATIO = 1.21;
/**
 * iOS `Text` centres each line in its line height, but a text field puts the extra space above the
 * letters. The field moves up by half of that space, so its words cover the words of the message.
 */
const IOS_BASELINE_SHIFT = (LINE_HEIGHT - FONT_SIZE * FONT_LINE_RATIO) / 2;

/**
 * The text of a message while the reader selects part of it in the bubble.
 *
 * iOS `Text` copies only a whole message, and `Text` on either platform does not report the
 * selected range, so a read-only text field covers the message text. It has the size and line
 * height of the body text, so the words stay where they are. It opens with all text selected;
 * the platform handles change the range, and the system menu has Copy and Select All.
 */
export function ChatSelectableText({
  text,
  color,
  onHeight,
  onSelectionChange,
  systemMenu = true,
}: {
  text: string;
  color: ColorValue | undefined;
  /** The height of the text, so the bubble grows when the plain text is longer than the message. */
  onHeight: (height: number) => void;
  /** The selected part of `text`. Empty when the selection is only a cursor. */
  onSelectionChange: (selected: string) => void;
  /**
   * Off where the chat shows its own actions for the selection, so the system menu does not cover
   * them. iOS only: Android cannot hide the menu and keep the selection.
   */
  systemMenu?: boolean;
}) {
  const { t } = useText();
  const { fontScale } = useWindowDimensions();
  const input = useRef<TextInputInstance>(null);
  const report = useRef(onSelectionChange);
  report.current = onSelectionChange;
  useEffect(() => {
    input.current?.focus();
    input.current?.setSelection(0, text.length);
    // Android takes the focus after this call and puts a cursor in place of the range, and neither
    // platform reports a range that the code sets. So the range is set again once the field has the
    // focus, and the chat hears of the whole text at once, to show the actions for it.
    const frame = requestAnimationFrame(() => {
      input.current?.setSelection(0, text.length);
      report.current(text);
      const tag = textSelection && input.current ? findNodeHandle(input.current) : null;
      if (typeof tag === "number") void textSelection?.selectAll(tag).catch(() => false);
    });
    return () => cancelAnimationFrame(frame);
  }, [text]);
  return (
    <TextInput
      ref={input}
      accessibilityLabel={t("mobile.chat.message.text")}
      value={text}
      multiline
      scrollEnabled={false}
      // Android disables a field that cannot be edited, and a disabled field selects nothing. There
      // the field stays editable with no keyboard, and `value` puts back any change.
      editable={!isIOS}
      showSoftInputOnFocus={false}
      caretHidden
      selectTextOnFocus
      // Android hides the menu by refusing its action mode, and that also ends the selection, so
      // Android keeps its menu.
      contextMenuHidden={!systemMenu && isIOS}
      onContentSizeChange={({ nativeEvent }) => onHeight(nativeEvent.contentSize.height)}
      onSelectionChange={({ nativeEvent }) =>
        onSelectionChange(text.slice(nativeEvent.selection.start, nativeEvent.selection.end))
      }
      className="absolute left-0 right-0 top-0 bg-transparent p-0 font-sans"
      style={{
        color,
        fontSize: FONT_SIZE,
        lineHeight: LINE_HEIGHT,
        transform: isIOS ? [{ translateY: -IOS_BASELINE_SHIFT * fontScale }] : undefined,
      }}
    />
  );
}
