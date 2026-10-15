fn main() {
    if super_high_lib::prompt_spacing::worker_requested() {
        std::process::exit(super_high_lib::prompt_spacing::run_worker_from_env());
    }
    std::process::exit(super_high_lib::run_cli_from_env());
}
