fn main() {
    // The icons are embedded in the binary; without this, regenerating them leaves a stale build.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
