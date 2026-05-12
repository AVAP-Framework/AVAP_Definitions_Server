#!/usr/bin/env python3
"""
AVAP Python → AVBC Compiler
Reads Python source from stdin (or file), compiles to AVBC bytecode, writes to stdout.

Usage:
  echo "python code" | python3 compiler.py
  python3 compiler.py --file command.py

Output: binary AVBC bytecode on stdout
Errors: JSON error on stderr
"""

import ast
import sys
import struct
import json
import os

# ---------------------------------------------------------------------------
# ISA loader — reads opcodes from opcodes.json (single source of truth)
# ---------------------------------------------------------------------------

class ISA:
    """
    Loads opcode definitions from an ISA JSON file.
    The compiler uses this instead of hardcoded constants so it works
    with any ISA that follows the AVBC contract.
    """
    def __init__(self, json_path: str):
        import json
        with open(json_path) as f:
            data = json.load(f)
        self.name    = data['name']
        self.version = tuple(data['version'])
        self.halt    = data['halt_opcode']
        self._ops    = {
            name: info['opcode']
            for name, info in data['instructions'].items()
        }
        # Expose as attributes for backward compat: isa.PUSH, isa.ADD, etc.
        for name, opcode in self._ops.items():
            setattr(self, name, opcode)

    def has(self, name: str) -> bool:
        return name in self._ops

# Default ISA path — can be overridden via --isa flag
DEFAULT_ISA_PATH = os.path.join(
    os.path.dirname(__file__),
    '..', 'avap-isa', 'opcodes.json'
)

# Legacy alias for code that still uses `self.isa.PUSH` style
# Will be replaced by self.isa.PUSH in the Compiler class
op = None  # set after ISA is loaded

# ---------------------------------------------------------------------------
# Constant pool builder
# ---------------------------------------------------------------------------

class ConstantPool:
    def __init__(self):
        self._pool = []
        self._index = {}

    def add(self, value):
        key = (type(value).__name__, value)
        if key not in self._index:
            self._index[key] = len(self._pool)
            self._pool.append(value)
        return self._index[key]

    def encode(self):
        buf = bytearray()
        for v in self._pool:
            if isinstance(v, bool):
                buf += bytes([0x05 if v else 0x06])
            elif isinstance(v, int):
                buf += bytes([0x02]) + struct.pack('<q', v)
            elif isinstance(v, float):
                buf += bytes([0x03]) + struct.pack('<d', v)
            elif isinstance(v, str):
                enc = v.encode('utf-8')
                buf += bytes([0x04]) + struct.pack('<I', len(enc)) + enc
            else:
                buf += bytes([0x01])  # Null
        return bytes(buf)

# ---------------------------------------------------------------------------
# Code emitter
# ---------------------------------------------------------------------------

class Emitter:
    def __init__(self, pool):
        self.pool = pool
        self.code = bytearray()

    def emit(self, opcode, *args):
        self.code.append(opcode)
        for arg in args:
            self.code += struct.pack('<I', arg)

    def pos(self):
        return len(self.code)

    def patch_u32(self, offset, value):
        struct.pack_into('<I', self.code, offset, value)

    def emit_jmp(self, opcode):
        """Emit a jump with a placeholder. Returns offset to patch."""
        self.code.append(opcode)
        offset = len(self.code)
        self.code += struct.pack('<I', 0)  # placeholder
        return offset

# ---------------------------------------------------------------------------
# Compiler
# ---------------------------------------------------------------------------

class UnsupportedNode(Exception):
    pass

class Compiler:
    # Known builtins that map to LOAD_BUILTIN + CALL_FUNC
    BUILTINS = {'str', 'int', 'float', 'bool', 'len', 'list', 'dict',
                'print', 'isinstance', 'next', 'iter', 'range',
                'type', 'hasattr', 'getattr', 'vars', 'locals', 'globals'}

    # Known modules
    MODULES = {'json', 're', 'hashlib', 'datetime', 'os', 'ast',
               'struct', 'hmac', 'pytz', 'requests', 'sqlalchemy'}

    def __init__(self, isa: ISA = None):
        # Load ISA — use default avap-isa/opcodes.json if not specified
        if isa is None:
            isa_path = os.environ.get('AVAP_ISA_PATH', DEFAULT_ISA_PATH)
            isa = ISA(isa_path)
        self.isa = isa
        self.pool = ConstantPool()
        self.emit = Emitter(self.pool)
        self._locals = {}       # name -> const_idx for local variable names
        self._imports = {}      # alias -> module name
        self._func_defs = {}    # name -> compiled sub-emitter (future)
        self._loop_stack = []   # for break/continue
        self._cv_counter = 0        # counter for conector-write sentinels

    def const(self, value):
        return self.pool.add(value)

    def name_idx(self, name):
        return self.pool.add(name)

    # ── Entry point ──────────────────────────────────────────────────────────

    def compile(self, source):
        tree = ast.parse(source)
        for node in tree.body:
            self._stmt(node)
        self.emit.emit(self.isa.HALT)
        return self._build_bytecode()

    def _build_bytecode(self):
        pool_bytes = self.pool.encode()
        code_bytes = bytes(self.emit.code)
        const_count = len(self.pool._pool)

        # AVBC header: 128 bytes
        # [0:4]   magic 'AVBC'
        # [4:6]   ISA version major.minor (u16 LE)
        # [6:8]   flags (u16 LE) = 0
        # [8:12]  code_size (u32 LE)
        # [12:16] const_count (u32 LE)
        # [16:20] entry_point (u32 LE) = 0
        # [20:128] reserved (zeros)
        isa_ver = (self.isa.version[0] << 8) | self.isa.version[1]
        header = bytearray(128)
        header[0:4]   = b'AVBC'
        struct.pack_into('<H', header, 4, isa_ver)     # ISA version
        struct.pack_into('<H', header, 6, 0)           # flags
        struct.pack_into('<I', header, 8, len(code_bytes))
        struct.pack_into('<I', header, 12, const_count)
        struct.pack_into('<I', header, 16, 0)          # entry = 0

        return bytes(header) + pool_bytes + code_bytes

    # ── Statement dispatch ───────────────────────────────────────────────────

    def _stmt(self, node):
        t = type(node).__name__

        if t == 'Expr':
            self._expr(node.value)
            self.emit.emit(self.isa.POP)  # discard expression result

        elif t == 'Assign':
            self._expr(node.value)
            for target in node.targets:
                self._store(target)

        elif t == 'AugAssign':
            self._load(node.target)
            self._expr(node.value)
            self._binop_code(node.op)
            self._store(node.target)

        elif t == 'AnnAssign' and node.value:
            self._expr(node.value)
            self._store(node.target)

        elif t == 'If':
            self._if(node)

        elif t == 'For':
            self._for(node)

        elif t == 'While':
            self._while(node)

        elif t == 'Try':
            self._try(node)

        elif t == 'Return':
            if node.value:
                self._expr(node.value)
            else:
                self.emit.emit(self.isa.LOAD_NONE)
            self.emit.emit(self.isa.RETURN)

        elif t == 'Import':
            for alias in node.names:
                name = alias.asname or alias.name
                self._imports[name] = alias.name
                if alias.name in self.MODULES:
                    idx = self.const(alias.name)
                    self.emit.emit(self.isa.IMPORT_MOD, idx)
                    self.emit.emit(self.isa.STORE, self.name_idx(name))
                # else: ignore unknown imports (e.g. exrex)

        elif t == 'ImportFrom':
            if node.module in self.MODULES:
                idx = self.const(node.module)
                self.emit.emit(self.isa.IMPORT_MOD, idx)
                mod_name = node.module
                for alias in node.names:
                    asname = alias.asname or alias.name
                    # GET_ATTR to get the specific name from the module
                    self.emit.emit(self.isa.DUP)
                    attr_idx = self.const(alias.name)
                    self.emit.emit(self.isa.GET_ATTR, attr_idx)
                    self.emit.emit(self.isa.STORE, self.name_idx(asname))
                self.emit.emit(self.isa.POP)  # pop module
            # else: ignore

        elif t == 'FunctionDef':
            # Inline function definitions: compile body inline, skip for now
            # Store as a marker so calls can find them
            self._func_defs[node.name] = node
            # Skip — function defs are compiled on-demand when called

        elif t == 'Pass':
            self.emit.emit(self.isa.NOP)

        elif t == 'Delete':
            for target in node.targets:
                if isinstance(target, ast.Subscript):
                    self._expr(target.value)
                    self._expr(target.slice)
                    self.emit.emit(self.isa.DELETE_ITEM)

        elif t in ('Break', 'Continue'):
            pass  # handled by loop compiler

        elif t == 'Global' or t == 'Nonlocal':
            pass  # ignore scope declarations

        else:
            raise UnsupportedNode(f"Unsupported statement: {t}")

    # ── Expression dispatch ──────────────────────────────────────────────────

    def _expr(self, node):
        t = type(node).__name__

        if t == 'Constant':
            if node.value is None:
                self.emit.emit(self.isa.LOAD_NONE)
            else:
                self.emit.emit(self.isa.PUSH, self.const(node.value))

        elif t == 'Name':
            self._load_name(node.id)

        elif t == 'Attribute':
            # self.conector is a ScriptBridge pattern used in exec() path.
            # In AVBC, 'self' already compiles to LOAD_CONECTOR (the conector dict),
            # so 'self.conector' must also resolve to LOAD_CONECTOR — not
            # LOAD_CONECTOR + GET_ATTR("conector"), which would push NULL.
            if (type(node.value).__name__ == 'Name'
                    and node.value.id == 'self'
                    and node.attr == 'conector'):
                self.emit.emit(self.isa.LOAD_CONECTOR)
            else:
                self._expr(node.value)
                self.emit.emit(self.isa.GET_ATTR, self.const(node.attr))

        elif t == 'Subscript':
            self._expr(node.value)
            self._expr(node.slice)
            self.emit.emit(self.isa.GET_ITEM)

        elif t == 'Index':  # Python 3.8 compat
            self._expr(node.value)

        elif t == 'BinOp':
            self._expr(node.left)
            self._expr(node.right)
            self._binop_code(node.op)

        elif t == 'UnaryOp':
            self._expr(node.operand)
            if   isinstance(node.op, ast.Not):    self.emit.emit(self.isa.NOT)
            elif isinstance(node.op, ast.USub):   self.emit.emit(self.isa.NEG)
            elif isinstance(node.op, ast.UAdd):   pass
            else: raise UnsupportedNode(f"UnaryOp: {node.op}")

        elif t == 'BoolOp':
            if isinstance(node.op, ast.And):
                # Short-circuit AND using JMP_IF_NOT — keeps value on stack
                # Pattern: eval left, if falsy jump to end (leaving False on stack)
                # otherwise pop and eval right, result is the final value
                self._expr(node.values[0])
                end_jumps = []
                for val in node.values[1:]:
                    # If current TOS is falsy, jump to end keeping it as result
                    j = self.emit.emit_jmp(self.isa.JMP_IF_NOT)
                    end_jumps.append(j)
                    # TOS was truthy, pop it and evaluate next
                    self.emit.emit(self.isa.POP)
                    self._expr(val)
                # Patch all short-circuit jumps to current position
                for j in end_jumps:
                    self.emit.patch_u32(j, self.emit.pos())
            else:
                # Short-circuit OR: if left is true, it's the result
                self._expr(node.values[0])
                end_jumps = []
                for val in node.values[1:]:
                    j = self.emit.emit_jmp(self.isa.JMP_IF)
                    end_jumps.append(j)
                    self.emit.emit(self.isa.POP)
                    self._expr(val)
                for j in end_jumps:
                    self.emit.patch_u32(j, self.emit.pos())

        elif t == 'Compare':
            self._expr(node.left)
            for cmp_op, comparator in zip(node.ops, node.comparators):
                self._expr(comparator)
                self._cmp_code(cmp_op)

        elif t == 'Call':
            self._call(node)

        elif t == 'IfExp':  # ternary: a if cond else b
            self._expr(node.test)
            false_jmp = self.emit.emit_jmp(self.isa.JMP_IF_NOT)
            self._expr(node.body)
            end_jmp = self.emit.emit_jmp(self.isa.JMP)
            self.emit.patch_u32(false_jmp, self.emit.pos())
            self._expr(node.orelse)
            self.emit.patch_u32(end_jmp, self.emit.pos())

        elif t == 'List':
            for elt in node.elts:
                self._expr(elt)
            self.emit.emit(self.isa.BUILD_LIST, len(node.elts))

        elif t == 'Dict':
            for k, v in zip(node.keys, node.values):
                self._expr(k)
                self._expr(v)
            self.emit.emit(self.isa.BUILD_DICT, len(node.keys))

        elif t == 'Tuple':
            for elt in node.elts:
                self._expr(elt)
            self.emit.emit(self.isa.BUILD_TUPLE, len(node.elts))

        elif t == 'JoinedStr':  # f-string
            self._fstring(node)

        elif t == 'ListComp':
            self._listcomp(node)

        elif t == 'Lambda':
            raise UnsupportedNode("Lambda not supported — rewrite as def")

        elif t == 'FormattedValue':
            self._expr(node.value)
            self.emit.emit(self.isa.LOAD_BUILTIN, self.const('str'))
            self.emit.emit(self.isa.CALL_FUNC, 1)

        else:
            raise UnsupportedNode(f"Unsupported expression: {t}")

    # ── Load / store helpers ─────────────────────────────────────────────────

    def _load_name(self, name):
        # Special AVAP runtime objects
        if name == 'self':
            self.emit.emit(self.isa.LOAD_CONECTOR)
        elif name == 'task':
            self.emit.emit(self.isa.LOAD_TASK)
        elif name in self.BUILTINS:
            self.emit.emit(self.isa.LOAD_BUILTIN, self.const(name))
        elif name == 'None':
            self.emit.emit(self.isa.LOAD_NONE)
        elif name == 'True':
            self.emit.emit(self.isa.PUSH, self.const(True))
        elif name == 'False':
            self.emit.emit(self.isa.PUSH, self.const(False))
        else:
            self.emit.emit(self.isa.LOAD, self.name_idx(name))

    def _load(self, node):
        if isinstance(node, ast.Name):
            self._load_name(node.id)
        elif isinstance(node, ast.Attribute):
            self._expr(node.value)
            self.emit.emit(self.isa.GET_ATTR, self.const(node.attr))
        elif isinstance(node, ast.Subscript):
            self._expr(node.value)
            self._expr(node.slice)
            self.emit.emit(self.isa.GET_ITEM)

    def _store(self, node):
        if isinstance(node, ast.Name):
            self.emit.emit(self.isa.STORE, self.name_idx(node.id))
        elif isinstance(node, ast.Attribute):
            self._expr(node.value)
            self.emit.emit(self.isa.SET_ATTR, self.const(node.attr))
        elif isinstance(node, ast.Subscript):
            # ── Conector write sentinel ──────────────────────────────────────
            # self.conector.variables[k] = v  and  self.conector.results[k] = v
            # would compile to SET_ITEM on a Value::Dict clone inside the VM.
            # That mutation is lost because Value::Dict is a value type (not a ref).
            #
            # Instead emit sentinel globals:
            #   __cvkey_N__ = k  /  __cvval_N__ = v   (for .variables writes)
            #   __crkey_N__ = k  /  __crval_N__ = v   (for .results writes)
            # main.py sync-back reads these pairs and applies the real writes
            # to self.conector.variables / self.conector.results after execute().
            obj = node.value
            # Match both self.variables[k] and self.conector.variables[k]
            def _is_conector_attr(node, attr):
                if not (isinstance(node, ast.Attribute) and node.attr == attr):
                    return False
                v = node.value
                # self.variables  or  self.results
                if isinstance(v, ast.Name) and v.id == 'self':
                    return True
                # self.conector.variables  or  self.conector.results
                if (isinstance(v, ast.Attribute) and v.attr == 'conector' and
                        isinstance(v.value, ast.Name) and v.value.id == 'self'):
                    return True
                return False
            if _is_conector_attr(obj, 'variables') or _is_conector_attr(obj, 'results'):
                obj_attr = obj.attr  # 'variables' or 'results'
                ns  = 'cv' if obj.attr == 'variables' else 'cr'
                n   = self._cv_counter
                self._cv_counter += 1
                # value is already TOS — save it
                self.emit.emit(self.isa.STORE, self.name_idx(f'__{ns}val_{n}__'))
                # evaluate the key and save it
                self._expr(node.slice)
                self.emit.emit(self.isa.STORE, self.name_idx(f'__{ns}key_{n}__'))
                return

            # General subscript assignment (non-conector)
            tmp = '__avbc_tmp__'
            self.emit.emit(self.isa.STORE, self.name_idx(tmp))
            self._expr(node.value)  # obj
            self._expr(node.slice)  # key
            self.emit.emit(self.isa.LOAD, self.name_idx(tmp))  # value back
            self.emit.emit(self.isa.SET_ITEM)
        elif isinstance(node, ast.Tuple):
            # Tuple unpacking: a, b = expr
            for i, elt in enumerate(node.elts):
                if i < len(node.elts) - 1:
                    self.emit.emit(self.isa.DUP)
                self.emit.emit(self.isa.PUSH, self.const(i))
                self.emit.emit(self.isa.GET_ITEM)
                self._store(elt)

    # ── Binary / comparison op codes ─────────────────────────────────────────

    def _binop_code(self, op_node):
        t = type(op_node).__name__
        table = {
            'Add': self.isa.ADD, 'Sub': self.isa.SUB, 'Mult': self.isa.MUL, 'Div': self.isa.DIV,
            'Mod': self.isa.MOD, 'FloorDiv': self.isa.DIV,
        }
        if t in table:
            self.emit.emit(table[t])
        else:
            raise UnsupportedNode(f"BinOp: {t}")

    def _cmp_code(self, op_node):
        t = type(op_node).__name__
        table = {
            'Eq': self.isa.EQ, 'NotEq': self.isa.NEQ, 'Lt': self.isa.LT, 'LtE': self.isa.LTE,
            'Gt': self.isa.GT, 'GtE': self.isa.GTE, 'In': self.isa.IN, 'NotIn': self.isa.NOT_IN,
            'Is': self.isa.IS, 'IsNot': self.isa.IS_NOT,
        }
        if t in table:
            self.emit.emit(table[t])
        else:
            raise UnsupportedNode(f"Compare: {t}")

    # ── Call ─────────────────────────────────────────────────────────────────

    def _call(self, node):
        func = node.func

        # Method call: obj.method(args)
        if isinstance(func, ast.Attribute):

            # ── dict.get(key) / dict.get(key, default) ──────────────────────
            # CALL_METHOD "get" is not supported by the Platon VM for Dict values.
            # Expand it inline as: key IN dict ? dict[key] : default
            # This keeps the stack contract identical to a normal method call:
            # exactly one value is pushed onto the stack.
            if func.attr == 'get' and len(node.args) in (1, 2):
                default_node = node.args[1] if len(node.args) == 2 else None
                key_node     = node.args[0]

                # Expand dict.get(key, default) using IN + GET_ITEM.
                # GET_ITEM on a nested Value::Dict inside __conector__ returns Null
                # even for existing keys. IN works correctly for dict key lookup.
                # So we gate GET_ITEM behind IN: only call it when IN confirms the key exists.
                #
                # Pattern:
                #   STORE dict → __dict_get_obj__
                #   STORE key  → __dict_get_key__
                #   LOAD key, LOAD dict
                #   IN                         → Bool (key exists?)
                #   JMP_IF_NOT_POP → [default] (falsy = key not found)
                #   LOAD dict, LOAD key
                #   GET_ITEM                   → value (IN confirmed it exists)
                #   JMP → [end]
                #   [default]: <default_expr>
                #   [end]:
                dict_tmp = '__dict_get_obj__'
                key_tmp  = '__dict_get_key__'
                self._expr(func.value)
                self.emit.emit(self.isa.STORE, self.name_idx(dict_tmp))
                self._expr(key_node)
                self.emit.emit(self.isa.STORE, self.name_idx(key_tmp))

                # IN check: key IN dict
                self.emit.emit(self.isa.LOAD, self.name_idx(key_tmp))
                self.emit.emit(self.isa.LOAD, self.name_idx(dict_tmp))
                self.emit.emit(self.isa.IN)
                false_jmp = self.emit.emit_jmp(self.isa.JMP_IF_NOT_POP)

                # truthy branch: key exists → fetch value
                self.emit.emit(self.isa.LOAD, self.name_idx(dict_tmp))
                self.emit.emit(self.isa.LOAD, self.name_idx(key_tmp))
                self.emit.emit(self.isa.GET_ITEM)
                end_jmp = self.emit.emit_jmp(self.isa.JMP)

                # falsy branch: key not found → default
                self.emit.patch_u32(false_jmp, self.emit.pos())
                if default_node is not None:
                    self._expr(default_node)
                else:
                    self.emit.emit(self.isa.LOAD_NONE)

                self.emit.patch_u32(end_jmp, self.emit.pos())
                return  # stack has exactly one value — done

            self._expr(func.value)
            for arg in node.args:
                self._expr(arg)
            for kw in node.keywords:
                self._expr(kw.value)
            n_args = len(node.args) + len(node.keywords)
            self.emit.emit(self.isa.CALL_METHOD, self.const(func.attr), n_args)

        # isinstance(obj, type) — use IS_INSTANCE opcode directly
        elif isinstance(func, ast.Name) and func.id == 'isinstance':
            self._expr(node.args[0])  # push obj
            type_arg = node.args[1] if len(node.args) > 1 else None
            if type_arg is None:
                self.emit.emit(self.isa.LOAD_NONE)
            elif isinstance(type_arg, ast.Tuple):
                # isinstance(x, (int, float)) — check against tuple of types
                # Push str names of types and use IS_INSTANCE
                for elt in type_arg.elts:
                    if isinstance(elt, ast.Name):
                        self.emit.emit(self.isa.LOAD_BUILTIN, self.const(elt.id))
                    else:
                        self._expr(elt)
                self.emit.emit(self.isa.BUILD_TUPLE, len(type_arg.elts))
                self.emit.emit(self.isa.IS_INSTANCE)
            else:
                # isinstance(x, str) — single type
                if isinstance(type_arg, ast.Name):
                    self.emit.emit(self.isa.LOAD_BUILTIN, self.const(type_arg.id))
                else:
                    self._expr(type_arg)
                self.emit.emit(self.isa.IS_INSTANCE)

        # Builtin function call
        elif isinstance(func, ast.Name) and func.id in self.BUILTINS:
            self.emit.emit(self.isa.LOAD_BUILTIN, self.const(func.id))
            for arg in node.args:
                self._expr(arg)
            self.emit.emit(self.isa.CALL_FUNC, len(node.args))

        # Locally defined function call (inline the body)
        elif isinstance(func, ast.Name) and func.id in self._func_defs:
            func_def = self._func_defs[func.id]
            # Push args as locals
            for i, (param, arg) in enumerate(zip(func_def.args.args, node.args)):
                self._expr(arg)
                self.emit.emit(self.isa.STORE, self.name_idx(param.arg))
            # Compile body inline
            for stmt in func_def.body:
                self._stmt(stmt)

        # Generic name call
        elif isinstance(func, ast.Name):
            self._load_name(func.id)
            for arg in node.args:
                self._expr(arg)
            self.emit.emit(self.isa.CALL_FUNC, len(node.args))

        else:
            raise UnsupportedNode(f"Call: {ast.dump(func)[:80]}")

    # ── Control flow ─────────────────────────────────────────────────────────

    def _if(self, node):
        self._expr(node.test)
        false_jmp = self.emit.emit_jmp(self.isa.JMP_IF_NOT_POP)

        for stmt in node.body:
            self._stmt(stmt)

        if node.orelse:
            end_jmp = self.emit.emit_jmp(self.isa.JMP)
            self.emit.patch_u32(false_jmp, self.emit.pos())
            for stmt in node.orelse:
                self._stmt(stmt)
            self.emit.patch_u32(end_jmp, self.emit.pos())
        else:
            self.emit.patch_u32(false_jmp, self.emit.pos())

    def _for(self, node):
        # Compile iterable and get iterator
        self._expr(node.iter)
        self.emit.emit(self.isa.GET_ITER)

        loop_start = self.emit.pos()
        exit_jmp = self.emit.emit_jmp(self.isa.FOR_ITER)  # patches to after loop

        # Store loop variable
        self._store(node.target)

        for stmt in node.body:
            self._stmt(stmt)

        # Jump back to loop start
        self.emit.emit(self.isa.JMP, loop_start)

        # Patch FOR_ITER exit
        self.emit.patch_u32(exit_jmp, self.emit.pos())

        # else clause (rarely used)
        for stmt in node.orelse:
            self._stmt(stmt)

    def _while(self, node):
        loop_start = self.emit.pos()
        self._expr(node.test)
        exit_jmp = self.emit.emit_jmp(self.isa.JMP_IF_NOT_POP)

        for stmt in node.body:
            self._stmt(stmt)

        self.emit.emit(self.isa.JMP, loop_start)
        self.emit.patch_u32(exit_jmp, self.emit.pos())

    def _try(self, node):
        # PUSH_TRY handler_ip, body, POP_TRY, JMP end, handler: except body
        handler_jmp = self.emit.emit_jmp(self.isa.PUSH_TRY)

        for stmt in node.body:
            self._stmt(stmt)

        self.emit.emit(self.isa.POP_TRY)
        end_jmp = self.emit.emit_jmp(self.isa.JMP)

        # Exception handler
        self.emit.patch_u32(handler_jmp, self.emit.pos())
        for handler in node.handlers:
            if handler.name:
                self.emit.emit(self.isa.STORE, self.name_idx(handler.name))
            else:
                self.emit.emit(self.isa.POP)
            for stmt in handler.body:
                self._stmt(stmt)

        self.emit.patch_u32(end_jmp, self.emit.pos())

        for stmt in node.finalbody if hasattr(node, 'finalbody') else []:
            self._stmt(stmt)

    # ── f-strings ────────────────────────────────────────────────────────────

    def _fstring(self, node):
        # Compile as concatenation of str() of each part
        parts = []
        for val in node.values:
            if isinstance(val, ast.Constant):
                self.emit.emit(self.isa.PUSH, self.const(str(val.value)))
            elif isinstance(val, ast.FormattedValue):
                self._expr(val.value)
                self.emit.emit(self.isa.LOAD_BUILTIN, self.const('str'))
                self.emit.emit(self.isa.CALL_FUNC, 1)
            parts.append(None)
        # Concatenate all parts
        for _ in range(len(parts) - 1):
            self.emit.emit(self.isa.ADD)

    # ── List comprehensions ───────────────────────────────────────────────────

    def _listcomp(self, node):
        # Compile as: result = []; for x in iter: if cond: result.append(x)
        tmp = '__avbc_lc__'
        self.emit.emit(self.isa.BUILD_LIST, 0)
        self.emit.emit(self.isa.STORE, self.name_idx(tmp))

        gen = node.generators[0]
        self._expr(gen.iter)
        self.emit.emit(self.isa.GET_ITER)

        loop_start = self.emit.pos()
        exit_jmp = self.emit.emit_jmp(self.isa.FOR_ITER)
        self._store(gen.target)

        # Apply conditions
        for if_clause in gen.ifs:
            self._expr(if_clause)
            skip_jmp = self.emit.emit_jmp(self.isa.JMP_IF_NOT_POP)
            self._expr(node.elt)
            self.emit.emit(self.isa.LOAD, self.name_idx(tmp))
            self.emit.emit(self.isa.CALL_METHOD, self.const('append'), 1)
            self.emit.emit(self.isa.POP)
            self.emit.patch_u32(skip_jmp, self.emit.pos())

        if not gen.ifs:
            self._expr(node.elt)
            self.emit.emit(self.isa.LOAD, self.name_idx(tmp))
            self.emit.emit(self.isa.CALL_METHOD, self.const('append'), 1)
            self.emit.emit(self.isa.POP)

        self.emit.emit(self.isa.JMP, loop_start)
        self.emit.patch_u32(exit_jmp, self.emit.pos())
        self.emit.emit(self.isa.LOAD, self.name_idx(tmp))

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def main():
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('--file', help='Python source file to compile')
    parser.add_argument('--name', default='unknown', help='Command name for error messages')
    parser.add_argument('--isa',  default=None,      help='Path to opcodes.json ISA definition')
    args = parser.parse_args()

    if args.file:
        with open(args.file, 'r') as f:
            source = f.read()
    else:
        source = sys.stdin.read()

    try:
        isa = ISA(args.isa) if args.isa else None
        compiler = Compiler(isa=isa)
        bytecode = compiler.compile(source)
        sys.stdout.buffer.write(bytecode)
        sys.stdout.buffer.flush()
    except UnsupportedNode as e:
        sys.stderr.write(json.dumps({
            'error': 'unsupported',
            'message': str(e),
            'command': args.name
        }) + '\n')
        sys.exit(1)
    except SyntaxError as e:
        sys.stderr.write(json.dumps({
            'error': 'syntax',
            'message': str(e),
            'command': args.name
        }) + '\n')
        sys.exit(2)

if __name__ == '__main__':
    main()