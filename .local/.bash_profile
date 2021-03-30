#echo $PWD
export THOME=$HOME/$REPL_SLUG
export TLOCAL=$THOME/.local
export DENO_DIR=$THOME/.deno
export PATH=$TLOCAL/usr/bin:$PATH
source $TLOCAL/deno_completion.bash
export ABC=XYZ
