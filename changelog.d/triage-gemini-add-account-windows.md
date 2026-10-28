### Fixed

- A second Gemini account stays after its Google sign-in when Gemini starts slowly, as it can on Windows. Before, OpenBot stopped the check after the sign-in at 30 seconds, and the new account disappeared.
- When a new provider account cannot sign in, OpenBot now shows an error with the reason. Before, the account disappeared with no message.
- Cancel on a provider account that is still connecting no longer waits until the provider finishes starting.
