#!/bin/zsh
# Скриншоты всех вариантов: ./shoot.sh [вариант...] → shots/<вариант>-<тема>.png
cd "${0:A:h}"
mkdir -p shots
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
variants=(${@:-current book draft poster dusk md})
for v in $variants; do
  for t in light dark; do
    "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
      --window-size=1360,${H:-2600} --virtual-time-budget=6000 \
      --screenshot="shots/$v-$t.png" "http://127.0.0.1:4411/?v=$v&t=$t" >/dev/null 2>&1
    echo "shots/$v-$t.png"
  done
done
