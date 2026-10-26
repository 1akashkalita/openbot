package run.openbot.textselection

import android.os.SystemClock
import android.view.MotionEvent
import android.widget.EditText
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Selects all text of a field with the selection handles and menu of Android.
 *
 * A range that code sets has no handles: Android draws them only in the selection mode that a touch
 * and hold starts. So the field gets the touch and hold that a finger gives it, on its first letter,
 * and then the whole range. The selection mode starts after the touch ends, with the whole range.
 */
class TextSelectionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("OpenBotTextSelection")

    /** Returns false when the view is not a text field with text. */
    AsyncFunction("selectAll") { viewTag: Int ->
      val field = appContext.findView<EditText>(viewTag) ?: return@AsyncFunction false
      val length = field.text?.length ?: 0
      val layout = field.layout
      if (length == 0 || layout == null) return@AsyncFunction false
      field.requestFocus()
      val x = field.totalPaddingLeft + layout.getPrimaryHorizontal(0) + 1f
      val y = field.totalPaddingTop + layout.getLineTop(0) + 1f
      val downTime = SystemClock.uptimeMillis()
      val down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, x, y, 0)
      val up = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0)
      // The app gave its own feedback for Select text.
      val haptics = field.isHapticFeedbackEnabled
      try {
        field.isHapticFeedbackEnabled = false
        field.dispatchTouchEvent(down)
        field.performLongClick()
        field.setSelection(0, length)
        field.dispatchTouchEvent(up)
        field.setSelection(0, length)
      } finally {
        field.isHapticFeedbackEnabled = haptics
        down.recycle()
        up.recycle()
      }
      true
    }.runOnQueue(Queues.MAIN)
  }
}
