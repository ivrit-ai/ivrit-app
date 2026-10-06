# Sourced by the Android build scripts: the toolchain, where this machine keeps
# it. Override any of these in the environment.
: "${IVRIT_TOOLS:=$HOME/.local/opt}"
: "${JAVA_HOME:=$(ls -d "$IVRIT_TOOLS"/jdk-21* 2>/dev/null | tail -1)}"
: "${ANDROID_HOME:=$IVRIT_TOOLS/android-sdk}"
NODE_DIR=$(ls -d "$IVRIT_TOOLS"/node-v22* 2>/dev/null | tail -1)
export JAVA_HOME ANDROID_HOME
export PATH="$JAVA_HOME/bin:${NODE_DIR:+$NODE_DIR/bin:}$ANDROID_HOME/platform-tools:$PATH"
