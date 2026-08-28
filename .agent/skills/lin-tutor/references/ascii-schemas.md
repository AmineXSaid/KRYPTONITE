# ASCII schemas

Diagram templates for LIN answers. `scripts/corpus.py schema <name>` prints
one. Copy the template exactly and replace only the `<...>` placeholders with
values taken from a tool output. Do not redraw the boxes, change the column
widths, or invent a new shape.

Every template is drawn for a monospaced font. The rules are dashes, not box
characters, because a proportional renderer breaks box drawing and a broken
diagram teaches nothing.

## frame anatomy

The whole frame, master header then slave response.

```
|<---------------- header (master) ---------------->|<---- response (slave) ---->|
+-----------+-----------+-----------+  +--------+--------+     +--------+  +-----+
|   BREAK   |   SYNC    |    PID    |  | DATA 1 | DATA 2 | ... | DATA n |  | CKSM|
|  >=13 dom |   0x55    |   <PID>   |  | <b1>   | <b2>   |     | <bn>   |  |<ck> |
+-----------+-----------+-----------+  +--------+--------+     +--------+  +-----+
 <----------- 34 Tbit nominal ------>   <-------- 10 x (n+1) Tbit nominal ------->

frame id  <0xNN>      n = <1..8> data bytes
checksum  <classic|enhanced>     baud <baud>   Tbit <t>us
```

## byte on the wire

One UART character. LSB first, and the placeholder row is the bit order the
value is actually sent in.

```
        start                    8 data bits, LSB first                   stop
        +---+---+---+---+---+---+---+---+---+---+
value   | 0 |b0 |b1 |b2 |b3 |b4 |b5 |b6 |b7 | 1 |
<0xNN>  +---+---+---+---+---+---+---+---+---+---+
        dom |<------------ 10 Tbit ------------>| rec

bits sent  <b0><b1><b2><b3><b4><b5><b6><b7>   (LSB .. MSB)
```

## pid parity

The protected identifier: six id bits and two parity bits.

```
 bit    7     6     5     4     3     2     1     0
      +-----+-----+-----+-----+-----+-----+-----+-----+
PID   | P1  | P0  | ID5 | ID4 | ID3 | ID2 | ID1 | ID0 |
<0xNN>+-----+-----+-----+-----+-----+-----+-----+-----+
      | <p1>| <p0>| <5> | <4> | <3> | <2> | <1> | <0> |
      +-----+-----+-----+-----+-----+-----+-----+-----+

P0 =   ID0 xor ID1 xor ID2 xor ID4   = <p0>
P1 = !(ID1 xor ID3 xor ID4 xor ID5)  = <p1>

frame id <0xNN> (6 bits) -> PID <0xNN>
```

## checksum

Classic sums the data only; enhanced folds the PID in first. Diagnostic frames
0x3C and 0x3D are always classic, whatever the rest of the cluster does.

```
kind      <classic|enhanced>
included  <data bytes only | PID + data bytes>

  <0xNN>            <- <PID, enhanced only>
+ <0xNN>            <- data 1
+ <0xNN>            <- data 2
+ ...
  -----
  <0xNNN>           sum with carry folded back into bit 0
  <0xNN>            8-bit result
  ~ -> <0xNN>       inverted = checksum on the wire
```

## schedule table

One pass of the schedule. The slot is what the master reserves; the frame is
what actually occupies it.

```
slot  frame          id     n  Tnom      slot time   cumulative
----  -------------  -----  -  --------  ----------  ----------
 <i>  <name>         <0xNN> <n> <t>ms     <t>ms       <t>ms
 <i>  <name>         <0xNN> <n> <t>ms     <t>ms       <t>ms
 <i>  <name>         <0xNN> <n> <t>ms     <t>ms       <t>ms
----  -------------  -----  -  --------  ----------  ----------
                                   table period      <t>ms

slot time must be >= Tframe_max = 1.4 x Tnom
```

## signal packing

Where a signal sits inside the frame's data bytes. Bit 0 is the LSB of byte 1.

```
frame <name> (<0xNN>), <n> data bytes

byte      1               2               3
bit  7 6 5 4 3 2 1 0   7 6 5 4 3 2 1 0   7 6 5 4 3 2 1 0
     +-+-+-+-+-+-+-+   +-+-+-+-+-+-+-+   +-+-+-+-+-+-+-+
     |<--- sigA --->|  |<-sigB->|        |               |
     +-+-+-+-+-+-+-+   +-+-+-+-+-+-+-+   +-+-+-+-+-+-+-+

signal   offset  size  init   publisher
-------  ------  ----  -----  ---------
<sigA>   <n>     <n>   <0xNN> <node>
<sigB>   <n>     <n>   <0xNN> <node>
```

## sleep and wake

The two transitions, and the timers that decide them.

```
ACTIVE ---- go-to-sleep ------> SLEEP ---- wakeup pulse ----> ACTIVE
            0x3C, data[0]=0x00              dominant
            rest 0xFF                       250us .. 5ms

or

ACTIVE ---- bus idle 4.0 s ---> SLEEP

observed  <what the trace shows>
expected  <which of the two above>
verdict   <legal | fault>

KL30 silence is a fault. KL15 silence is legal.
```

## diagnostic frame

The transport layer riding on 0x3C and 0x3D.

```
direction  <request 0x3C | response 0x3D>

byte    1      2      3      4      5      6      7      8
      +------+------+------+------+------+------+------+------+
      | NAD  | PCI  | SID  | D1   | D2   | D3   | D4   | D5   |
      |<0xNN>|<0xNN>|<0xNN>|<0xNN>|<0xNN>|<0xNN>|<0xNN>|<0xNN>|
      +------+------+------+------+------+------+------+------+

NAD  <0xNN>  the node address ON THE WIRE
PCI  <0xNN>  <single frame, len n | first frame | consecutive frame>
SID  <0xNN>  <service name>
unused bytes are 0xFF
```

## trace divergence

Expected above observed, a caret at the first byte that differs, one cause.

```
        <field>  <field>  <field>  <field>  <field>
expect   <0xNN>   <0xNN>   <0xNN>   <0xNN>   <0xNN>
actual   <0xNN>   <0xNN>   <0xNN>   <0xNN>   <0xNN>
                             ^
                             first divergence

layer   <wire | header | response | checksum | schedule | config>
cause   <one cause, one line>
```

## failure ladder

Bottom-up. Stop at the first layer that explains it; do not list the rest.

```
  layer       question                              <ok|FAIL>
  ---------   -----------------------------------   ---------
5 config      right LDF, right NAD, right baud?     <..>
4 schedule    was the slot even sent?               <..>
3 checksum    classic vs enhanced correct?          <..>
2 response    did the slave answer, n bytes?        <..>
1 header      break >=13, sync 0x55, PID parity?    <..>
0 wire        levels, termination, ground?          <..>

stopped at layer <n>: <one line>
```

## frame timing

The budget for one frame, and where the slack goes.

```
baud        <baud> bit/s      Tbit = 1/<baud> = <t>us

header      34 Tbit                  = <t>us
response    10 x (<n> + 1) Tbit      = <t>us
            --------------------------------
Tnom                                 = <t>us
Tmax        1.4 x Tnom               = <t>us

observed    <t>us       <within | over> budget by <t>us
```

## node view

Who publishes what, which is the question behind most "who is wrong" answers.

```
frame <name> (<0xNN>)

               publisher            subscribers
               ------------------   ------------------
               <node>               <node>, <node>

master task    <node>   (sends every header)
slave task     <node>   (answers this id)

a node can hold both tasks; only the slave task puts data on the wire
```

## test case shape

The four parts of a LIN test case, in the order an answer should give them.

```
requirement  <id>  <the shall, one sentence>
setup        <preconditions, one line>
stimulus     <what the master sends>       <0xNN> ...
observable   <what must appear on the bus> <0xNN> ...
passes iff   <the assertion, one line>

covered by   <test path>   or   uncovered
```
