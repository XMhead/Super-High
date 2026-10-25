fn main() {
    if std::env::args().nth(1).as_deref() == Some("__service-console") {
        std::process::exit(super_high_lib::service_console::worker_from_env());
    }
    std::process::exit(super_high_lib::run_cli_from_env());
}
