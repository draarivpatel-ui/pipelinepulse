# PipelinePulse | Syntax Summit

Name: PipelinePulse, a CI pipeline health and cost studio

Description:
PipelinePulse reads a GitHub Actions style workflow and models its run time, cost and failures in the browser. A hand written YAML subset parser builds the model and rejects bad input with line numbers and recovery hints instead of guessing. The pipeline map draws jobs in topological waves with dependency edges and a highlighted critical path. Duration math computes medians and p90 from run history and simulates runner queues. The cost model bills per job and matrix combination from an editable rate table with monthly projections and cache accounting. Failure patterns cluster errors by normalized signature, separate flaky from hard failures, and rank jobs by burned minutes. The savings bench prices five optimizations, every estimate labeled with assumptions and the total marked an upper bound. Seventy three unit tests cover the parser, pipeline math, cost model, failure clustering, and savings rules. Fixtures are clearly synthetic.

Try it: https://aariv.me/pipelinepulse/
Code: https://github.com/draarivpatel-ui/pipelinepulse

Video URL: https://youtu.be/a1TUerZQNIg
