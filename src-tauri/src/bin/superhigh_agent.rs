//! `superhigh-agent.exe` — standalone HTTP file server for remote Windows.
//! Zero runtime dependencies. Copy to remote server and run.

use std::{env, path::PathBuf, process};

fn main() {
    let mut port: u16 = 10310;
    let mut token = String::new();
    let mut root = String::new();
    let mut bind = "0.0.0.0".to_string();

    let args = env::args().skip(1).collect::<Vec<_>>();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                if i < args.len() {
                    port = args[i].parse().unwrap_or(10310);
                }
            }
            "--token" => {
                i += 1;
                if i < args.len() {
                    token = args[i].clone();
                }
            }
            "--root" => {
                i += 1;
                if i < args.len() {
                    root = args[i].clone();
                }
            }
            "--bind" => {
                i += 1;
                if i < args.len() {
                    bind = args[i].clone();
                }
            }
            "--help" | "-h" => {
                print_help();
                return;
            }
            _ => {
                eprintln!("未知参数: {}", args[i]);
                print_help();
                process::exit(1);
            }
        }
        i += 1;
    }

    if token.is_empty() {
        eprintln!("错误：需要 --token 参数");
        print_help();
        process::exit(1);
    }
    if root.is_empty() {
        eprintln!("错误：需要 --root 参数");
        print_help();
        process::exit(1);
    }

    let root_path = PathBuf::from(&root);
    if !root_path.exists() {
        eprintln!("错误：目录不存在 - {}", root);
        process::exit(1);
    }
    if !root_path.is_dir() {
        eprintln!("错误：不是目录 - {}", root);
        process::exit(1);
    }

    super_high_lib::agent_server::run_agent(super_high_lib::agent_server::AgentConfig {
        port,
        token,
        root: root_path,
        bind,
    });
}

fn print_help() {
    println!("Super High Remote Agent");
    println!(
        "用法: superhigh-agent.exe --port <端口> --token <令牌> --root <根目录> [--bind <地址>]"
    );
    println!();
    println!("  --port  监听端口 (默认 10310)");
    println!("  --token 认证令牌 (必填)");
    println!("  --root  暴露的根目录路径 (必填)");
    println!("  --bind  绑定地址 (默认 0.0.0.0)");
    println!();
    println!("示例:");
    println!(r#"  superhigh-agent.exe --port 10310 --token "mypassword" --root "E:\项目\plugins""#);
}
