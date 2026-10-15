//! Conservative scope proofs. User command text is parsed, never executed.
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
#[derive(Clone, Default, Debug, Deserialize)]
pub struct CommandScope {
    pub files: BTreeSet<String>,
    pub prefixes: BTreeSet<String>,
}
#[derive(Deserialize)]
struct Proof {
    exact: bool,
    #[serde(flatten)]
    scope: CommandScope,
    #[serde(default)]
    profiles: Vec<String>,
}
fn parser_host(program: &str, no_profile: bool) -> Option<PathBuf> {
    let requested = Path::new(program);
    let leaf = requested.file_name()?.to_str()?.to_ascii_lowercase();
    let candidate = if matches!(leaf.as_str(), "powershell" | "powershell.exe") {
        PathBuf::from(std::env::var_os("SystemRoot")?)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe")
    } else if matches!(leaf.as_str(), "pwsh" | "pwsh.exe") {
        PathBuf::from(std::env::var_os("ProgramFiles")?).join("PowerShell/7/pwsh.exe")
    } else {
        return None;
    };
    if requested.is_absolute() {
        let actual = std::fs::canonicalize(requested).ok()?;
        let known = std::fs::canonicalize(&candidate).ok()?;
        if !actual
            .to_string_lossy()
            .eq_ignore_ascii_case(&known.to_string_lossy())
        {
            return None;
        }
    } else if !no_profile || program.contains('/') {
        return None;
    }
    Some(candidate)
}
fn profiles_absent(paths: &[String]) -> bool {
    paths.len()==4 && paths.iter().all(|p|Path::new(p).is_absolute()&&matches!(std::fs::symlink_metadata(p),Err(e) if e.kind()==std::io::ErrorKind::NotFound))
}
pub fn parse_powershell_scope(command: &str, cwd: &Path) -> Option<CommandScope> {
    if command.len() > 128 * 1024 || command.to_ascii_lowercase().contains("redacted") {
        return None;
    }
    let args = shlex::split(command)?;
    let program = args.first()?.replace('\\', "/");
    if !matches!(
        program.rsplit('/').next()?.to_ascii_lowercase().as_str(),
        "powershell" | "powershell.exe" | "pwsh" | "pwsh.exe"
    ) {
        return None;
    }
    let mut index = 1;
    let mut no_profile = false;
    let mut script = None;
    while index < args.len() {
        match args[index].to_ascii_lowercase().as_str() {
            "-noprofile" => no_profile = true,
            "-nologo" | "-noninteractive" => {}
            "-executionpolicy" => {
                index += 1;
                if args.get(index)?.to_ascii_lowercase() != "bypass" {
                    return None;
                }
            }
            "-command" | "-c" => {
                index += 1;
                if index + 1 != args.len() {
                    return None;
                }
                script = Some(args.get(index)?.clone());
                break;
            }
            _ => return None,
        }
        index += 1;
    }
    let script = script?;
    if script.len() > 64 * 1024 {
        return None;
    }
    let payload =
        serde_json::to_vec(&serde_json::json!({"script":script,"cwd":cwd.to_string_lossy(),"verifyProfiles":!no_profile}))
            .ok()?;
    let executable = parser_host(&program, no_profile)?;
    let mut cmd = Command::new(executable);
    cmd.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        PARSER,
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn().ok()?;
    let stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(512 * 1024).read_to_end(&mut bytes);
        result.map(|_| bytes)
    });
    let sent = child
        .stdin
        .take()
        .is_some_and(|mut input| input.write_all(&payload).is_ok());
    let started = Instant::now();
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break sent && status.success(),
            Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                std::thread::sleep(Duration::from_millis(10))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let bytes = reader.join().ok()?.ok()?;
    if !success {
        return None;
    }
    let proof: Proof = serde_json::from_slice(&bytes).ok()?;
    if !no_profile && !profiles_absent(&proof.profiles) {
        return None;
    }
    proof.exact.then_some(proof.scope)
}

// Only the fixed parser runs in the child. ParseInput does not run the submitted AST.
const PARSER: &str = r#"
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
try {
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
$script:cwd=[IO.Path]::GetFullPath([string]$request.cwd)
$script:vars=@{}
$script:files=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$script:prefixes=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$script:opaque=[pscustomobject]@{opaque=$true}
function Fail { throw 'unknown' }
function Target($value,$prefix=$false) {
  foreach($p in @($value)) {
    if($p -isnot [string] -or $p.Length -eq 0 -or $p.IndexOfAny([char[]]'*?[]') -ge 0){Fail}
    if(![IO.Path]::IsPathRooted($p)){$p=[IO.Path]::Combine($script:cwd,$p)}
    $p=[IO.Path]::GetFullPath($p)
    if($prefix){[void]$script:prefixes.Add($p)}else{[void]$script:files.Add($p)}
    if(($script:files.Count+$script:prefixes.Count) -gt 128){Fail}
  }
}
function ArgsOf($ast) {
  if($ast.InvocationOperator.ToString() -eq 'Dot' -or $ast.Redirections.Count){Fail}
  $pos=New-Object 'System.Collections.Generic.List[object]';$named=@{}
  for($i=1;$i -lt $ast.CommandElements.Count;$i++) {
    $e=$ast.CommandElements[$i]
    if($e -is [System.Management.Automation.Language.CommandParameterAst]) {
      $name=$e.ParameterName.ToLowerInvariant()
      if($name -in @('force','recurse','raw','nonewline','passthru','parent')){$v=$true}
      elseif($name -in @('path','literalpath','childpath','itemtype','value','encoding','erroraction')) {
        if($e.Argument){$v=Eval $e.Argument}else{$i++;if($i -ge $ast.CommandElements.Count){Fail};$v=Eval $ast.CommandElements[$i]}
      }else{Fail}
      if($named.ContainsKey($name)){Fail};$named[$name]=$v
    } else {[void]$pos.Add((Eval $e))}
  }
  return @{pos=$pos;named=$named}
}
function Cmd($ast) {
  $name=$ast.GetCommandName();if(!$name){Fail};$name=$name.ToLowerInvariant()
  $a=ArgsOf $ast;$pos=$a.pos;$n=$a.named
  switch($name) {
    'get-location' {if($pos.Count -or $n.Count){Fail};return $script:cwd}
    'join-path' {
      if($n.ContainsKey('path')){$left=$n.path}else{$left=$pos[0]}
      if($n.ContainsKey('childpath')){$right=$n.childpath}else{$right=$pos[1]}
      if($left -isnot [string] -or $right -isnot [string] -or $pos.Count -gt 2){Fail}
      return [IO.Path]::Combine($left,$right)
    }
    'split-path' {
      if($n.ContainsKey('literalpath')){$p=$n.literalpath}elseif($n.ContainsKey('path')){$p=$n.path}else{$p=$pos[0]}
      if($p -isnot [string] -or $pos.Count -gt 1){Fail};return [IO.Path]::GetDirectoryName($p)
    }
    {$_ -in @('set-content','add-content','new-item','remove-item','get-content','test-path')} {
      if($n.ContainsKey('literalpath')){$p=$n.literalpath}elseif($n.ContainsKey('path')){$p=$n.path}else{$p=$pos[0]}
      if(!$p){Fail}
      if($name -in @('set-content','add-content')){Target $p}
      elseif($name -eq 'new-item') {
        if($n.itemtype -isnot [string]){Fail}
        if($n.itemtype.ToLowerInvariant() -eq 'directory'){Target $p $true}
        elseif($n.itemtype.ToLowerInvariant() -eq 'file'){Target $p}else{Fail}
      }elseif($name -eq 'remove-item'){Target $p;if($n.recurse){Target $p $true}}
      return $script:opaque
    }
    {$_ -in @('out-null','write-output','write-host')} {return $script:opaque}
    default {Fail}
  }
}
function Eval($a) {
  if(!$a){Fail}
  switch($a.GetType().Name) {
    'StringConstantExpressionAst' {return $a.Value}
    'ConstantExpressionAst' {return $a.Value}
    'ExpandableStringExpressionAst' {if($a.NestedExpressions.Count){Fail};return $a.Value}
    'VariableExpressionAst' {
      if($a.Splatted){Fail}
      $name=$a.VariablePath.UserPath.ToLowerInvariant()
      if($name -eq 'null'){return $null};if($name -eq 'true'){return $true};if($name -eq 'false'){return $false}
      if(!$script:vars.ContainsKey($name)){Fail};return $script:vars[$name]
    }
    'ParenExpressionAst' {return Eval $a.Pipeline}
    'CommandExpressionAst' {if($a.Redirections.Count){Fail};return Eval $a.Expression}
    'PipelineAst' {
      $value=$script:opaque
      foreach($element in $a.PipelineElements){if($element -is [System.Management.Automation.Language.CommandAst]){$value=Cmd $element}else{$value=Eval $element}}
      return $value
    }
    'ArrayLiteralAst' {return ,@($a.Elements|ForEach-Object {Eval $_})}
    'BinaryExpressionAst' {
      $left=Eval $a.Left;$right=Eval $a.Right
      if($a.Operator.ToString() -eq 'Plus' -and $left -is [string] -and $right -is [string]){return $left+$right}
      if($a.Operator.ToString() -in @('Ieq','Ine','Ceq','Cne','And','Or')){return $script:opaque};Fail
    }
    'UnaryExpressionAst' {if($a.TokenKind.ToString() -notin @('Not','Exclaim')){Fail};[void](Eval $a.Child);return $script:opaque}
    'ConvertExpressionAst' {if($a.Type.TypeName.FullName -notin @('string','int')){Fail};return Eval $a.Child}
    'MemberExpressionAst' {
      if(!$a.Static -or $a.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst]){Fail}
      $type=$a.Expression.TypeName.FullName.ToLowerInvariant();$member=$a.Member.Value.ToLowerInvariant()
      if($type -in @('text.encoding','system.text.encoding') -and $member -in @('utf8','unicode','ascii','utf32','bigendianunicode')){return $script:opaque};Fail
    }
    'InvokeMemberExpressionAst' {
      if($a.Member -isnot [System.Management.Automation.Language.StringConstantExpressionAst]){Fail}
      $member=$a.Member.Value.ToLowerInvariant();$args=@($a.Arguments|ForEach-Object {Eval $_})
      if($a.Static) {
        if($a.Expression -isnot [System.Management.Automation.Language.TypeExpressionAst]){Fail}
        $type=$a.Expression.TypeName.FullName.ToLowerInvariant()
        if($type -in @('io.path','system.io.path')) {
          if($member -eq 'getdirectoryname' -and $args.Count -eq 1 -and $args[0] -is [string]){return [IO.Path]::GetDirectoryName($args[0])}
          if($member -eq 'combine' -and $args.Count -ge 2 -and $args.Count -le 4){foreach($p in $args){if($p -isnot [string]){Fail}};return [IO.Path]::Combine([string[]]$args)}
        }
        if($type -in @('io.file','system.io.file')) {
          if($member -in @('writealltext','appendalltext') -and $args.Count -in @(2,3)){Target $args[0];return $script:opaque}
          if($member -eq 'delete' -and $args.Count -eq 1){Target $args[0];return $script:opaque}
          if($member -in @('readalltext','exists') -and $args.Count -in @(1,2)){return $script:opaque}
        }
        if($type -in @('io.directory','system.io.directory')) {
          if($member -eq 'createdirectory' -and $args.Count -eq 1){Target $args[0] $true;return $script:opaque}
          if($member -eq 'delete' -and $args.Count -in @(1,2)){Target $args[0] $true;return $script:opaque}
        }
        Fail
      }
      $receiver=Eval $a.Expression
      if($receiver -is [string] -and $member -eq 'tostring' -and $args.Count -eq 0){return $receiver};Fail
    }
    default {Fail}
  }
}
function Statements($block,$conditional=$false) {
  if($block.Traps.Count){Fail}
  foreach($s in $block.Statements) {
    switch($s.GetType().Name) {
      'AssignmentStatementAst' {
        if($conditional -or $s.Operator.ToString() -ne 'Equals' -or $s.Left -isnot [System.Management.Automation.Language.VariableExpressionAst]){Fail}
        $name=$s.Left.VariablePath.UserPath.ToLowerInvariant()
        if($name.Contains(':') -or $name.StartsWith('ps') -or $name -in @('pwd','home','executioncontext','host','input','args','null','true','false','ofs')){Fail}
        $script:vars[$name]=Eval $s.Right
      }
      'PipelineAst' {[void](Eval $s)}
      'IfStatementAst' {
        foreach($clause in $s.Clauses){[void](Eval $clause.Item1);Statements $clause.Item2 $true}
        if($s.ElseClause){Statements $s.ElseClause $true}
      }
      'ExitStatementAst' {if($s.Pipeline){[void](Eval $s.Pipeline)}}
      default {Fail}
    }
  }
}
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseInput([string]$request.script,[ref]$tokens,[ref]$errors)
if($errors.Count -or $ast.ParamBlock -or $ast.BeginBlock -or $ast.ProcessBlock -or $ast.DynamicParamBlock -or $ast.ScriptRequirements -or $ast.UsingStatements.Count -or !$ast.EndBlock){Fail}
Statements $ast.EndBlock
$profiles=@()
if($request.verifyProfiles){$profiles=@([string]$PROFILE.AllUsersAllHosts,[string]$PROFILE.AllUsersCurrentHost,[string]$PROFILE.CurrentUserAllHosts,[string]$PROFILE.CurrentUserCurrentHost)}
@{exact=$true;files=@($script:files);prefixes=@($script:prefixes);profiles=$profiles}|ConvertTo-Json -Depth 5 -Compress
} catch { '{"exact":false,"files":[],"prefixes":[]}' }
"#;

#[cfg(test)]
mod tests {
    use super::*;
    fn encoded(script: &str) -> String {
        shlex::try_join(["powershell.exe", "-NoProfile", "-Command", script]).unwrap()
    }
    #[test]
    fn changes_scope_ast_proves_paths_after_posix_argv_decode() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("中文目录");
        std::fs::create_dir(&cwd).unwrap();
        let script="$p=Join-Path (Get-Location) '.agent/tmp/dir/file.txt'; $dir=[IO.Path]::GetDirectoryName($p); New-Item -ItemType Directory -Force -Path $dir | Out-Null; [IO.File]::WriteAllText($p,'one'); Set-Content -LiteralPath $p -Value 'two' -Encoding UTF8; Get-Content -LiteralPath $p; exit 7";
        let scope = parse_powershell_scope(&encoded(script), &cwd).unwrap();
        assert!(scope
            .files
            .iter()
            .any(|p| Path::new(p) == cwd.join(".agent/tmp/dir/file.txt")));
        assert!(!cwd.join(".agent/tmp/dir/file.txt").exists());
    }
    #[test]
    fn changes_scope_default_pwsh_command_with_absent_real_host_profiles() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().join("中文默认宿主");
        std::fs::create_dir(&cwd).unwrap();
        let program =
            PathBuf::from(std::env::var_os("ProgramFiles").unwrap()).join("PowerShell/7/pwsh.exe");
        let script="New-Item -ItemType Directory -Force -Path '.agent/tmp/command-changes-click-20261013' | Out-Null\nSet-Content -LiteralPath '.agent/tmp/command-changes-click-20261013/jump-probe.txt' -Encoding UTF8 -Value '第一行验收'\nAdd-Content -LiteralPath '.agent/tmp/command-changes-click-20261013/jump-probe.txt' -Encoding UTF8 -Value '第二行跳转验收'\nGet-Content -LiteralPath '.agent/tmp/command-changes-click-20261013/jump-probe.txt' -Encoding UTF8";
        let command = shlex::try_join([program.to_str().unwrap(), "-Command", script]).unwrap();
        let scope = parse_powershell_scope(&command, &cwd).unwrap();
        assert!(scope.files.iter().any(|p| Path::new(p)
            == cwd.join(".agent/tmp/command-changes-click-20261013/jump-probe.txt")));
        assert!(!cwd.join(".agent").exists());
    }
    #[test]
    fn changes_scope_profile_metadata_requires_all_four_absent() {
        let root = tempfile::tempdir().unwrap();
        let paths: Vec<_> = (0..4)
            .map(|n| {
                root.path()
                    .join(format!("profile{n}.ps1"))
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert!(profiles_absent(&paths));
        std::fs::write(&paths[2], "").unwrap();
        assert!(!profiles_absent(&paths));
        assert!(!profiles_absent(&paths[..3]));
        assert!(parser_host("pwsh.exe", false).is_none());
    }
    #[test]
    fn changes_scope_unknown_or_redacted_never_proves_writes() {
        let root = tempfile::tempdir().unwrap();
        for script in [
            "Set-Content $env:DEST x",
            "& unknown.exe; Set-Content 'x.txt' x",
            "[IO.File]::WriteAllText('x.txt',(Invoke-Expression 'danger'))",
            "$p='x'; Set-Content $p x; function hidden { unknown }",
            "trap { Set-Content 'hidden.txt' x }; Set-Content 'known.txt' x",
        ] {
            assert!(parse_powershell_scope(&encoded(script), root.path()).is_none());
        }
        assert!(parse_powershell_scope("", root.path()).is_none());
        assert!(
            parse_powershell_scope(&encoded("Set-Content '<redacted>' x"), root.path()).is_none()
        );
        assert!(
            parse_powershell_scope(&encoded("Get-Content 'x.txt' -Raw"), root.path())
                .unwrap()
                .files
                .is_empty()
        );
    }
}
