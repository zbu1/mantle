//! English (US) spell checking with a bundled Hunspell dictionary. Words never
//! leave the process. Added words live in one plaintext list in the app's local
//! data, shared by every vault and never written into one.

use spellbook::Dictionary;
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};

// ponytail: compiled in rather than a Tauri resource, so Android needs no
// resource lookup; the cost is ~550 KB of binary.
const AFF: &str = include_str!("../resources/dictionary/index.aff");
const DIC: &str = include_str!("../resources/dictionary/index.dic");

struct Speller {
    dict: Dictionary,
    words_file: PathBuf,
}

fn speller(app: &AppHandle) -> Result<&'static Mutex<Speller>, String> {
    static SPELLER: OnceLock<Mutex<Speller>> = OnceLock::new();
    if let Some(s) = SPELLER.get() {
        return Ok(s);
    }
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let words_file = dir.join("dictionary.txt");
    let mut dict = Dictionary::new(AFF, DIC).map_err(|e| format!("Failed to load the dictionary: {e}"))?;
    for word in fs::read_to_string(&words_file).unwrap_or_default().lines() {
        let _ = dict.add(word.trim());
    }
    Ok(SPELLER.get_or_init(|| Mutex::new(Speller { dict, words_file })))
}

/// The words of `words` that are misspelled.
#[tauri::command]
pub fn spell_check(app: AppHandle, words: Vec<String>) -> Result<Vec<String>, String> {
    let s = speller(&app)?.lock().map_err(|e| e.to_string())?;
    Ok(words.into_iter().filter(|w| !s.dict.check(w)).collect())
}

/// `None` when `word` is spelled right, else what it might have meant, best first.
#[tauri::command]
pub fn spelling_suggestions(app: AppHandle, word: String) -> Result<Option<Vec<String>>, String> {
    let s = speller(&app)?.lock().map_err(|e| e.to_string())?;
    if s.dict.check(&word) {
        return Ok(None);
    }
    let mut out = Vec::new();
    s.dict.suggest(&word, &mut out);
    Ok(Some(out))
}

#[tauri::command]
pub fn add_to_dictionary(app: AppHandle, word: String) -> Result<(), String> {
    let word = word.trim();
    if word.is_empty() || word.contains(['\n', '\r', '/']) {
        return Err("Not a word".into());
    }
    let mut s = speller(&app)?.lock().map_err(|e| e.to_string())?;
    s.dict.add(word).map_err(|e| e.to_string())?;
    if let Some(dir) = s.words_file.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut list = fs::read_to_string(&s.words_file).unwrap_or_default();
    list.push_str(word);
    list.push('\n');
    fs::write(&s.words_file, list).map_err(|e| format!("Failed to save the word: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_suggests_only_for_misspellings() {
        let dict = Dictionary::new(AFF, DIC).unwrap();
        assert!(dict.check("the"));
        let mut out = Vec::new();
        assert!(!dict.check("teh"));
        dict.suggest("teh", &mut out);
        assert!(out.iter().any(|w| w == "the"));
    }
}
