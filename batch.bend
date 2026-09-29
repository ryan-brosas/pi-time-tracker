# Stack-safe numeric batch plumbing for the native and sequential JS backends.
# Bend 2.0.31 Base splitting/length/sort-runs/join recurse once per character
# or row. Accumulators keep these paths tail-recursive; merge stays in Base.
import Base

def reverse_text(text: String, out: String) -> String:
  match text:
    case SNil{}:
      out
    case SCon{h, t}:
      reverse_text(t, SCon{h, out})

# CRLF logs arrive as lines ending in one CR; dropping CR once from the whole text
# keeps every downstream field parse unchanged. A match may not scrutinize a
# computed value, so each decision lives in a def whose scrutinee is a parameter.
def push_char(is_cr: Bool, c: Char, out: String) -> String:
  match is_cr:
    case True{}:
      out
    case False{}:
      SCon{c, out}

def strip_cr_rev(text: String, out: String) -> String:
  match text:
    case SNil{}:
      out
    case SCon{+h, t}:
      strip_cr_rev(t, push_char(Char.is_eq(h, '\r'), h, out))

def strip_cr(text: String) -> String:
  reverse_text(strip_cr_rev(text, ""), "")

def split_step(c: Char, current: String, out: List<&2, String>, cut: Bool) -> String & List<&2, String>:
  match cut:
    case True{}:
      ("", reverse_text(current, "") <> out)
    case False{}:
      (SCon{c, current}, out)

def split_go(text: String, +sep: Char, state: String & List<&2, String>) -> List<&2, String>:
  match text:
    case SNil{}:
      (current, out) = state
      List.reverse(&2, String, reverse_text(current, "") <> out)
    case SCon{+h, t}:
      (current, out) = state
      split_go(t, sep, split_step(h, current, out, Char.is_eq(h, sep)))

def split(text: String, sep: Char) -> List<&2, String>:
  split_go(text, sep, ("", Nil{}))

# Renderers accumulate rows in reverse order. Prepending each short row avoids
# recursion proportional to output length and repeated native prefix copies.
def concat_reversed(rows: List<&2, String>, out: String) -> String:
  match rows:
    case Nil{}:
      out
    case h <> t:
      concat_reversed(t, h ++ out)

def runs(-A: Data, xs: List<&2, A>, n: Nat, out: List<&2, List<&2, A>>) -> Nat & List<&2, List<&2, A>>:
  match xs:
    case Nil{}:
      (n, List.reverse(&2, List<&2, A>, out))
    case h <> t:
      runs(A, t, Nat.add(n, 1n), [h] <> out)

def sort_pass(~A: Data, ~le: A -> A -> Bool, rows: List<&2, List<&2, A>>, +n: Nat, out: List<&2, List<&2, A>>) -> List<&2, List<&2, A>>:
  match rows:
    case Nil{}:
      List.reverse(&2, List<&2, A>, out)
    case r <> Nil{}:
      List.reverse(&2, List<&2, A>, r <> out)
    case r1 <> r2 <> rest:
      sort_pass(~A, ~le, rest, n, List.merge.go(~A, ~le, n, (Nil{}, r1, r2)) <> out)

def flatten(-A: Data, rows: List<&2, List<&2, A>>, out: List<&2, A>) -> List<&2, A>:
  match rows:
    case Nil{}:
      List.reverse(&2, A, out)
    case h <> t:
      flatten(A, t, List.reverse.go(&2, A, h, out))

# Invariant: fuel must equal the initial run count n; each pass halves the runs.
def sort_go(~A: Data, ~le: A -> A -> Bool, fuel: Nat, +n: Nat, rows: List<&2, List<&2, A>>) -> List<&2, A>:
  match fuel:
    case 0n:
      flatten(A, rows, Nil{})
    case 1n+f:
      match rows:
        case Nil{}:
          Nil{}
        case r <> Nil{}:
          r
        case r1 <> r2 <> rest:
          sort_go(~A, ~le, f, n, sort_pass(~A, ~le, r1 <> r2 <> rest, n, Nil{}))

def sort_ready(~A: Data, ~le: A -> A -> Bool, state: Nat & List<&2, List<&2, A>>) -> List<&2, A>:
  (+n, rows) = state
  sort_go(~A, ~le, n, n, rows)

def sort(~A: Data, ~le: A -> A -> Bool, xs: List<&2, A>) -> List<&2, A>:
  sort_ready(~A, ~le, runs(A, xs, 0n, Nil{}))
