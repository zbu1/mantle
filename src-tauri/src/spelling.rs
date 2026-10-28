//! Spelling suggestions for the editor's right-click menu, which replaces the
//! webview's own menu and with it the suggestions that menu would have shown.

/// `None` when `word` is spelled right (or there's no spell checker to ask),
/// else what it might have meant, best first.
#[tauri::command]
pub fn spelling_suggestions(word: String) -> Option<Vec<String>> {
    imp::suggestions(&word)
}

// ponytail: Windows only (the OS spell checker WebView2 underlines with);
// add NSSpellChecker / hunspell arms when other desktops need it.
#[cfg(not(windows))]
mod imp {
    pub fn suggestions(_word: &str) -> Option<Vec<String>> {
        None
    }
}

#[cfg(windows)]
mod imp {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Globalization::{GetUserDefaultLocaleName, ISpellChecker, ISpellCheckerFactory, SpellCheckerFactory};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    pub fn suggestions(word: &str) -> Option<Vec<String>> {
        unsafe {
            // Already initialized on most threads; either way, harmless.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let factory: ISpellCheckerFactory = CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER).ok()?;
            let checker = checker(&factory)?;
            let word = HSTRING::from(word);
            let mut error = None;
            // S_FALSE with no error means the word is fine.
            let _ = checker.Check(&word).ok()?.Next(&mut error);
            error?;
            let suggestions = checker.Suggest(&word).ok()?;
            let mut found = Vec::new();
            let mut next = [PWSTR::null()];
            while suggestions.Next(&mut next, None).is_ok() && !next[0].is_null() {
                found.push(next[0].to_string().unwrap_or_default());
                CoTaskMemFree(Some(next[0].0 as _));
                next[0] = PWSTR::null();
            }
            Some(found)
        }
    }

    /// One for the user's language, else US English.
    unsafe fn checker(factory: &ISpellCheckerFactory) -> Option<ISpellChecker> {
        let mut locale = [0u16; 85];
        let len = unsafe { GetUserDefaultLocaleName(&mut locale) };
        let user = String::from_utf16_lossy(&locale[..(len.max(1) - 1) as usize]);
        let found = [user.as_str(), "en-US"].into_iter().find_map(|tag| {
            let tag = HSTRING::from(tag);
            let supported = unsafe { factory.IsSupported(&tag) }.is_ok_and(|b| b.as_bool());
            supported.then(|| unsafe { factory.CreateSpellChecker(&tag) }.ok()).flatten()
        });
        found
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn test_suggests_only_for_misspellings() {
        assert_eq!(spelling_suggestions("the".into()), None);
        assert!(spelling_suggestions("teh".into()).is_some_and(|s| s.iter().any(|w| w == "the")));
    }
}
