# One move taught slowly, then repeated faster

Teaching a step the viewer has never seen: row two is picked out first, the multiple of row one that matches it is shown as the reason the move works, the first subtraction plays slowly on the words that say it, the second goes at normal pace under one phrase, and the third is quick, so the viewer sees the pattern (everything under the pivot clearing) rather than three separate chores.

Narration: "We want a zero under the first two. Look at row two: it starts with four. Row one starts with two, and two times two is four. So take two of row one away from row two. Every number in row two changes, and the four becomes zero. Row three is the same move: add row one, and its first number goes. One more, faster, and the system is a staircase."

```scene
@0
math t latex="\text{Clear under the pivot}" role=title
matrix m data=[[2,1,1,5],[4,3,3,13],[-2,2,1,1]] ops=["R2-2R1","R3+R1","R3-3R2"] aug=1 w=1000 h=900
mark ring m.cell.1.1
@8 keep
light m.row.2
mark ring m.cell.2.1
@16 keep
light m.row.1
@21 keep
math k latex="2\times R_1 = \begin{bmatrix}4 & 2 & 2 & 10\end{bmatrix}"
light m.cell.2.1
@27 keep
do steps m from=1 to=1 pace=slow at=@37
@48 keep
drop k
do steps m from=2 to=2 at=@54
@62 keep
do steps m from=3 to=3 pace=fast at=@64
```
