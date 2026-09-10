; Remove only the optional registration owned by the executable being removed.
; Keep it during an update; the user's enabled setting survives upgrades.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ReadRegStr $0 HKCU "Software\Classes\SuperHigh.ImageViewer\shell\open\command" ""
    ${If} $0 == '$"$INSTDIR\super-high.exe$" --media-viewer $"%1$"'
      !insertmacro SUPERHIGH_REMOVE_IMAGE png
      !insertmacro SUPERHIGH_REMOVE_IMAGE jpg
      !insertmacro SUPERHIGH_REMOVE_IMAGE jpeg
      !insertmacro SUPERHIGH_REMOVE_IMAGE gif
      !insertmacro SUPERHIGH_REMOVE_IMAGE webp
      !insertmacro SUPERHIGH_REMOVE_IMAGE bmp
      !insertmacro SUPERHIGH_REMOVE_IMAGE svg
      !insertmacro SUPERHIGH_REMOVE_IMAGE ico
      !insertmacro SUPERHIGH_REMOVE_IMAGE avif
      DeleteRegKey HKCU "Software\Classes\SuperHigh.ImageViewer"
    ${EndIf}
  ${EndIf}
!macroend

!macro SUPERHIGH_REMOVE_IMAGE EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "SuperHigh.ImageViewer"
!macroend
