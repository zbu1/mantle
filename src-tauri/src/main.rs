// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some(mantle_lib::TYPST_WORKER_ARG) {
        mantle_lib::typst_worker()
    }
    mantle_lib::run()
}
